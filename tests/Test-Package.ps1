[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$plugin = Join-Path $repo 'plugins\codex-task-control'
$app = Join-Path $plugin 'app'

$required = @(
    (Join-Path $repo 'README.md'),
    (Join-Path $repo 'HUMAN_GUIDE.md'),
    (Join-Path $repo 'CODEX_INSTALL.md'),
    (Join-Path $repo 'SECURITY.md'),
    (Join-Path $repo 'SECURITY_REVIEW.md'),
    (Join-Path $repo 'PRIVACY.md'),
    (Join-Path $plugin 'plugin.json'),
    (Join-Path $plugin '.codex-plugin\plugin.json'),
    (Join-Path $plugin 'skills\codex-task-control\SKILL.md'),
    (Join-Path $plugin 'scripts\Install-CodexTaskControl.ps1'),
    (Join-Path $app 'ControlCenter.mjs'),
    (Join-Path $app 'CodexHostBridge.mjs'),
    (Join-Path $app 'UsageIntelligence.mjs'),
    (Join-Path $app 'UsageAnnotations.mjs'),
    (Join-Path $app 'SpellingService.mjs'),
    (Join-Path $app 'Get-SpellingSuggestions.ps1'),
    (Join-Path $app 'Get-CodexUsageStats.mjs'),
    (Join-Path $app 'Get-CodexUsageStats.ps1'),
    (Join-Path $app 'public\index.html')
)
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing required file: $file" }
}

$jsonFiles = @(
    (Join-Path $repo '.agents\plugins\marketplace.json'),
    (Join-Path $plugin 'plugin.json'),
    (Join-Path $plugin '.codex-plugin\plugin.json'),
    (Join-Path $app 'config.example.json')
)
foreach ($file in $jsonFiles) {
    Get-Content -LiteralPath $file -Raw | ConvertFrom-Json | Out-Null
}

$nodeFiles = @(Get-ChildItem -LiteralPath $app -Filter '*.mjs' -File)
foreach ($file in $nodeFiles) {
    & node --check $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $($file.FullName)" }
}

$powershellFiles = @(
    Get-ChildItem -LiteralPath $app -Filter '*.ps1' -File
    Get-ChildItem -LiteralPath (Join-Path $plugin 'scripts') -Filter '*.ps1' -File
)
foreach ($file in $powershellFiles) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "PowerShell syntax check failed: $($file.FullName): $($errors[0].Message)" }
}

$spellHelper = Join-Path $app 'Get-SpellingSuggestions.ps1'
$spellRequest = @{ word = 'speling'; language = 'en-AU'; limit = 3 } | ConvertTo-Json -Compress
$spellPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$spellResult = $spellRequest |
    & $spellPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $spellHelper |
    ConvertFrom-Json
if ($null -eq $spellResult.available -or $null -eq $spellResult.suggestions) {
    throw 'The local spelling helper did not return its documented result shape.'
}
if ($spellResult.available -and (-not $spellResult.misspelled -or @($spellResult.suggestions) -notcontains 'spelling')) {
    throw 'The local spelling helper did not suggest the expected correction.'
}

$allText = ($required + $jsonFiles + @($nodeFiles.FullName) + @($powershellFiles.FullName) |
    Select-Object -Unique |
    ForEach-Object { Get-Content -LiteralPath $_ -Raw }) -join "`n"
$forbidden = @(
    ('C:\Users\' + 'Kel' + 'sier'),
    ('Paul' + 'ine H'),
    ('Sen' + 'ate' + [char]92 + 'Codex Recovery'),
    ('01a0b831-4c82-' + '7200-b483-a95139f7d707'),
    ('[TO' + 'DO:')
)
foreach ($value in $forbidden) {
    if ($allText.IndexOf($value, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Forbidden private or placeholder value found: $value" }
}
if ($allText -match '0\.0\.0\.0') { throw 'The package must not bind to all network interfaces.' }

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-task-control-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
$configPath = Join-Path $temporaryRoot 'config.json'
@{
    port = $port
    recentTaskLimit = 5
    maxPromptBytes = 32768
    enableEndLocalWork = $false
    openBrowserOnShortcut = $false
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$oldConfig = $env:CODEX_TASK_CONTROL_CONFIG
$env:CODEX_TASK_CONTROL_CONFIG = $configPath
$process = $null
try {
    $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + (Join-Path $app 'ControlCenter.mjs') + '"') -WorkingDirectory $app -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 } catch { $health = $null }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health) { throw 'Health endpoint did not start.' }
    if ($health.app -ne 'codex-task-control' -or $health.host -ne '127.0.0.1' -or $health.port -ne $port) { throw 'Health endpoint returned unexpected data.' }
}
finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    $env:CODEX_TASK_CONTROL_CONFIG = $oldConfig
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}

Write-Output 'PACKAGE_TESTS_OK'
