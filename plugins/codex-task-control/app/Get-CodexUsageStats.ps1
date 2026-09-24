[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ThreadId,
    [ValidateRange(1, 3650)]
    [int]$Days = 30,
    [ValidateRange(1, 1000)]
    [int]$MaxSessions = 50,
    [ValidateRange(1048576, 10737418240)]
    [long]$MaxBytes = 1073741824,
    [switch]$IncludeArchived,
    [switch]$MeasurePromptSize,
    [switch]$All,
    [switch]$Pretty
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'Get-CodexUsageStats.mjs'
$arguments = @($script)
if ($ThreadId) { $arguments += @('--thread', $ThreadId) } else { $arguments += @('--recent', '--days', [string]$Days, '--max', [string]$MaxSessions, '--max-bytes', [string]$MaxBytes) }
if ($IncludeArchived) { $arguments += '--include-archived' }
if ($MeasurePromptSize) { $arguments += '--measure-prompt-size' }
if ($All) { $arguments += '--all' }
if ($Pretty) { $arguments += '--pretty' }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw "Usage statistics exited with code $LASTEXITCODE." }
