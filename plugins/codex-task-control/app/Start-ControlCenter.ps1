[CmdletBinding()]
param(
    [switch]$NoOpen,
    [ValidatePattern('^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')]
    [string]$ThreadId
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$serverPath = Join-Path $PSScriptRoot 'ControlCenter.mjs'
$configPath = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Missing control centre server: $serverPath" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing control centre config: $configPath" }

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = [int]$config.port
if ($port -lt 1024 -or $port -gt 65535) { throw 'The configured port is invalid.' }
$url = "http://127.0.0.1:$port/"
$healthUrl = $url + 'health'
$node = (Get-Command node.exe -ErrorAction Stop).Source

function Test-ControlCenter {
    try {
        $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        return $result.app -eq 'codex-task-control'
    }
    catch { return $false }
}

function Get-CodexPackage {
    return Get-AppxPackage -Name 'OpenAI.Codex' |
        Sort-Object { [version]$_.Version } -Descending |
        Select-Object -First 1
}

function Test-CodexRunning($Package) {
    $root = $Package.InstallLocation.TrimEnd('\') + '\'
    return @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
}

$package = Get-CodexPackage
if (-not $package) { throw 'The supported OpenAI Codex Windows app is not installed for this account.' }
if (-not (Test-CodexRunning -Package $package)) {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $appId = @($manifest.Package.Applications.Application)[0].Id
    if (-not $appId) { $appId = 'App' }
    $target = "shell:AppsFolder\$($package.PackageFamilyName)!$appId"
    Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $target
    $deadline = (Get-Date).AddSeconds(20)
    do { Start-Sleep -Milliseconds 500 } while (-not (Test-CodexRunning -Package $package) -and (Get-Date) -lt $deadline)
    if (-not (Test-CodexRunning -Package $package)) { throw 'Codex did not start within 20 seconds.' }
}

if (-not (Test-ControlCenter)) {
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { throw "Port $port is already in use by another program." }
    Start-Process -FilePath $node -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline -and -not (Test-ControlCenter)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-ControlCenter)) { throw 'Codex Command and Control could not start.' }
}

$targetUrl = if ($ThreadId) { $url + '?threadId=' + $ThreadId.ToLowerInvariant() } else { $url }
if (-not $NoOpen -and $config.openBrowserOnShortcut -ne $false) { Start-Process -FilePath $targetUrl }
Write-Output $targetUrl
