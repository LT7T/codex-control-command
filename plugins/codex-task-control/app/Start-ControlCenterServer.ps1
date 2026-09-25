[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$serverPath = Join-Path $PSScriptRoot 'ControlCenter.mjs'
$configPath = Join-Path $PSScriptRoot 'config.json'
$installPath = Join-Path $PSScriptRoot 'install.json'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Missing control centre server: $serverPath" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing control centre config: $configPath" }

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = [int]$config.port
if ($port -lt 1024 -or $port -gt 65535) { throw 'The configured port is invalid.' }
$url = "http://127.0.0.1:$port/"
$healthUrl = $url + 'health'

function Test-ControlCenter {
    try {
        $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        return $result.app -eq 'codex-task-control'
    }
    catch { return $false }
}

function Test-CompatibleNode([string]$Candidate) {
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
    if ([System.IO.Path]::GetFileName($Candidate) -ne 'node.exe') { return $false }
    try {
        $versionText = (& $Candidate --version 2>$null).Trim().TrimStart('v')
        return ([version]$versionText).Major -ge 20
    }
    catch { return $false }
}

function Resolve-NodeExecutable {
    $candidates = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $installPath -PathType Leaf) {
        try {
            $metadata = Get-Content -LiteralPath $installPath -Raw | ConvertFrom-Json
            if ($metadata.PSObject.Properties.Name -contains 'nodePath') {
                $candidates.Add([string]$metadata.nodePath)
            }
        }
        catch { }
    }

    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates.Add([string]$command.Source) }

    @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe' })
    ) | Where-Object { $_ } | ForEach-Object { $candidates.Add([string]$_) }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-CompatibleNode -Candidate $candidate) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    throw 'Node.js 20 or later could not be found. Rerun the Codex Command and Control installer so it can record the validated Node.js location.'
}

if (-not (Test-ControlCenter)) {
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { throw "Port $port is already in use by another program." }
    $node = Resolve-NodeExecutable
    Start-Process -FilePath $node -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline -and -not (Test-ControlCenter)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-ControlCenter)) { throw 'Codex Command and Control could not start.' }
}

Write-Output $url
