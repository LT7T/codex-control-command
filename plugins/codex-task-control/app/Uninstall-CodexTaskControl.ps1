[CmdletBinding(SupportsShouldProcess)]
param([switch]$KeepConfig)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$installRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$allowedRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
$marker = Join-Path $installRoot 'install.json'
if (-not $installRoot.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw 'Uninstall refused because this is not the expected Codex Command and Control installation.'
}
$metadata = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
$recordedRoot = [System.IO.Path]::GetFullPath([string]$metadata.installRoot).TrimEnd('\')
if ($metadata.app -ne 'codex-task-control' -or $recordedRoot -ne $installRoot) {
    throw 'Uninstall refused because the installation marker does not match this directory.'
}

try { & (Join-Path $installRoot 'Stop-ControlCenter.ps1') | Out-Null } catch { }
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Start Codex Command and Control.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Start Codex Task Control.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'End All Local Codex Work.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Command and Control\Start Codex Command and Control.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Command and Control\End All Local Codex Work.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Command and Control\Uninstall Codex Command and Control.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Task Control\Start Codex Task Control.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Task Control\End All Local Codex Work.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Task Control\Uninstall Codex Task Control.lnk')
)
foreach ($shortcut in $shortcutPaths) {
    if (Test-Path -LiteralPath $shortcut -PathType Leaf) { Remove-Item -LiteralPath $shortcut -Force }
}
$startMenuFolders = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Command and Control'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Task Control')
)
foreach ($startMenuFolder in $startMenuFolders) {
    if (Test-Path -LiteralPath $startMenuFolder -PathType Container) {
        Remove-Item -LiteralPath $startMenuFolder -Force -ErrorAction SilentlyContinue
    }
}
if ($KeepConfig -and (Test-Path -LiteralPath (Join-Path $installRoot 'config.json'))) {
    Copy-Item -LiteralPath (Join-Path $installRoot 'config.json') -Destination (Join-Path $env:LOCALAPPDATA 'CodexTaskControl.config.backup.json') -Force
}
if ($PSCmdlet.ShouldProcess($installRoot, 'Remove Codex Command and Control')) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
}
