[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexTaskControl'),
    [switch]$NoDesktopShortcuts,
    [switch]$Start,
    [switch]$NoBrowser
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$appVersion = '0.3.1'

$pluginRoot = Split-Path $PSScriptRoot -Parent
$sourceApp = Join-Path $pluginRoot 'app'
if (-not (Test-Path -LiteralPath (Join-Path $sourceApp 'ControlCenter.mjs') -PathType Leaf)) {
    throw "The plugin app folder is incomplete: $sourceApp"
}
$node = Get-Command node.exe -ErrorAction Stop
$nodeVersionText = (& $node.Source --version).TrimStart('v')
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion.Major -lt 20) { throw "Node.js 20 or later is required. Found $nodeVersionText." }
$package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
if (-not $package) { throw 'The supported OpenAI Codex Windows app is not installed for this account.' }

$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$defaultInstallRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexTaskControl')).TrimEnd('\')
$allowedInstallRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
if ($resolvedInstallRoot.Length -lt 12 -or
    -not $resolvedInstallRoot.StartsWith($allowedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installation path must be a dedicated directory under LocalAppData.'
}

if (Test-Path -LiteralPath (Join-Path $resolvedInstallRoot 'Stop-ControlCenter.ps1') -PathType Leaf) {
    try { & (Join-Path $resolvedInstallRoot 'Stop-ControlCenter.ps1') | Out-Null } catch { }
}
$existingConfig = $null
if (Test-Path -LiteralPath (Join-Path $resolvedInstallRoot 'config.json') -PathType Leaf) {
    $existingConfig = Get-Content -LiteralPath (Join-Path $resolvedInstallRoot 'config.json') -Raw
}
New-Item -ItemType Directory -Path $resolvedInstallRoot -Force | Out-Null
Copy-Item -Path (Join-Path $sourceApp '*') -Destination $resolvedInstallRoot -Recurse -Force
if ($existingConfig) {
    Set-Content -LiteralPath (Join-Path $resolvedInstallRoot 'config.json') -Value $existingConfig -Encoding UTF8
} else {
    Copy-Item -LiteralPath (Join-Path $sourceApp 'config.example.json') -Destination (Join-Path $resolvedInstallRoot 'config.json') -Force
}

[ordered]@{
    app = 'codex-task-control'
    version = $appVersion
    installedAt = (Get-Date).ToString('o')
    installRoot = $resolvedInstallRoot
    defaultInstallRoot = ($resolvedInstallRoot -eq $defaultInstallRoot)
    nodePath = [System.IO.Path]::GetFullPath($node.Source)
    nodeVersion = $nodeVersionText
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resolvedInstallRoot 'install.json') -Encoding UTF8

$shell = New-Object -ComObject WScript.Shell
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Command and Control'
$legacyStartMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Task Control'
New-Item -ItemType Directory -Path $startMenuFolder -Force | Out-Null

function New-ControlShortcut([string]$ShortcutPath, [string]$ScriptName, [string]$Arguments, [string]$Description, [string]$Hotkey) {
    $scriptPath = Join-Path $resolvedInstallRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Missing installed script: $scriptPath" }
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '"' + $Arguments
    $shortcut.WorkingDirectory = $resolvedInstallRoot
    $shortcut.Description = $Description
    if ($Hotkey) { $shortcut.Hotkey = $Hotkey }
    $shortcut.Save()
}

$shortcutDefinitions = @(
    @('Start Codex Command and Control.lnk', 'Start-ControlCenter.ps1', '', 'Start Codex and open the local command-and-control centre.', 'CTRL+ALT+SHIFT+R'),
    @('End All Local Codex Work.lnk', 'Stop-AllLocalCodexWork.ps1', ' -ShowResult', 'Interrupt all local Codex work and close the app.', 'CTRL+ALT+SHIFT+X'),
    @('Uninstall Codex Command and Control.lnk', 'Uninstall-CodexTaskControl.ps1', '', 'Remove Codex Command and Control from this computer.', '')
)
foreach ($definition in $shortcutDefinitions) {
    New-ControlShortcut -ShortcutPath (Join-Path $startMenuFolder $definition[0]) -ScriptName $definition[1] -Arguments $definition[2] -Description $definition[3] -Hotkey $definition[4]
}
if (-not $NoDesktopShortcuts) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    New-ControlShortcut -ShortcutPath (Join-Path $desktop 'Start Codex Command and Control.lnk') -ScriptName 'Start-ControlCenter.ps1' -Arguments '' -Description 'Start Codex and open the local command-and-control centre.' -Hotkey 'CTRL+ALT+SHIFT+R'
    New-ControlShortcut -ShortcutPath (Join-Path $desktop 'End All Local Codex Work.lnk') -ScriptName 'Stop-AllLocalCodexWork.ps1' -Arguments ' -ShowResult' -Description 'Interrupt all local Codex work and close the app.' -Hotkey 'CTRL+ALT+SHIFT+X'
}

$legacyShortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Start Codex Task Control.lnk'),
    (Join-Path $legacyStartMenuFolder 'Start Codex Task Control.lnk'),
    (Join-Path $legacyStartMenuFolder 'End All Local Codex Work.lnk'),
    (Join-Path $legacyStartMenuFolder 'Uninstall Codex Task Control.lnk')
)
foreach ($legacyShortcut in $legacyShortcutPaths) {
    if (Test-Path -LiteralPath $legacyShortcut -PathType Leaf) { Remove-Item -LiteralPath $legacyShortcut -Force }
}
if (Test-Path -LiteralPath $legacyStartMenuFolder -PathType Container) {
    Remove-Item -LiteralPath $legacyStartMenuFolder -Force -ErrorAction SilentlyContinue
}

if ($Start) {
    $startArgs = @{}
    if ($NoBrowser) { $startArgs.NoOpen = $true }
    & (Join-Path $resolvedInstallRoot 'Start-ControlCenter.ps1') @startArgs
}

[pscustomobject]@{
    Success = $true
    Version = $appVersion
    InstallRoot = $resolvedInstallRoot
    ConfigPath = (Join-Path $resolvedInstallRoot 'config.json')
    StartMenuFolder = $startMenuFolder
    DesktopShortcuts = (-not $NoDesktopShortcuts)
} | ConvertTo-Json -Compress
