[CmdletBinding()]
param(
    [switch]$NoOpen,
    [ValidatePattern('^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')]
    [string]$ThreadId
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'config.json'
$serverStarterPath = Join-Path $PSScriptRoot 'Start-ControlCenterServer.ps1'
$startupErrorPath = Join-Path $PSScriptRoot 'startup-error.log'
if (-not (Test-Path -LiteralPath $serverStarterPath -PathType Leaf)) { throw "Missing control centre server launcher: $serverStarterPath" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing control centre config: $configPath" }

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

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

function Write-StartupFailure([string]$Message) {
    @(
        'Codex Command and Control startup failed.'
        'Time: ' + (Get-Date).ToString('o')
        'Error: ' + $Message
    ) | Set-Content -LiteralPath $startupErrorPath -Encoding UTF8
    if (-not $NoOpen) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shell.Popup("Codex Command and Control could not start.`n`n$Message`n`nDetails: $startupErrorPath", 0, 'Codex Command and Control', 16) | Out-Null
        }
        catch { }
    }
}

try {
    # Bring up the loopback server before touching Codex. A cold Codex launch can
    # be slow, but it must not prevent the local page from becoming available.
    $url = & $serverStarterPath

    $targetUrl = if ($ThreadId) { $url + '?threadId=' + $ThreadId.ToLowerInvariant() } else { $url }
    if (-not $NoOpen -and $config.openBrowserOnShortcut -ne $false) { Start-Process -FilePath $targetUrl }

    try {
        $package = Get-CodexPackage
        if (-not $package) {
            Write-Warning 'The local server is running, but the supported OpenAI Codex Windows app is not installed for this account.'
        } elseif (-not (Test-CodexRunning -Package $package)) {
            $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
            $appId = @($manifest.Package.Applications.Application)[0].Id
            if (-not $appId) { $appId = 'App' }
            $target = "shell:AppsFolder\$($package.PackageFamilyName)!$appId"
            Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $target
        }
    }
    catch {
        Write-Warning "The local server is running, but Codex could not be launched automatically: $($_.Exception.Message)"
    }

    if (Test-Path -LiteralPath $startupErrorPath -PathType Leaf) { Remove-Item -LiteralPath $startupErrorPath -Force }
    Write-Output $targetUrl
}
catch {
    Write-StartupFailure -Message $_.Exception.Message
    throw
}
