$ErrorActionPreference = 'Stop'
$expectedVersion = if ($env:EXPECTED_UPDATE_VERSION) { $env:EXPECTED_UPDATE_VERSION } else { (Get-Content package.json -Raw | ConvertFrom-Json).version }
$root = Join-Path $env:RUNNER_TEMP 'authgate-auto-update'
$installDirectory = Join-Path $root 'app'
$application = Join-Path $installDirectory 'AuthGate-IP-Agent.exe'
New-Item -ItemType Directory -Force $root | Out-Null
# No login or configured unit: update delivery must work independently of authentication.
foreach ($name in @('AuthGate Atualizador de IP', 'authgate-ip-updater')) {
    $directory = Join-Path $env:APPDATA $name
    New-Item -ItemType Directory -Force $directory | Out-Null
    Set-Content (Join-Path $directory 'settings.json') '{"autoStart":false}' -NoNewline
}
$installer = Join-Path $root 'previous.exe'
Invoke-WebRequest 'https://github.com/TropaDigital/AUTHGATE-IP-UPDATER/releases/download/v1.3.4/AuthGate-IP-Agent-Setup-1.3.4.exe' -OutFile $installer
$setup = Start-Process $installer -ArgumentList "/S /D=$installDirectory" -PassThru
if (-not $setup.WaitForExit(120000) -or $setup.ExitCode -ne 0) { throw 'Baseline installation failed.' }
try {
    Write-Host "Baseline version: $((Get-Item $application).VersionInfo.ProductVersion)"
    Start-Process $application -ArgumentList '--background' -RedirectStandardOutput (Join-Path $root 'stdout.log') -RedirectStandardError (Join-Path $root 'stderr.log')
    $deadline = (Get-Date).AddMinutes(6)
    $updated = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if (Test-Path $application) {
            $installedVersion = (Get-Item $application).VersionInfo.ProductVersion
            $running = @(Get-Process 'AuthGate-IP-Agent' -ErrorAction SilentlyContinue)
            if ($installedVersion -eq $expectedVersion -and $running.Count -gt 0) {
                $updated = $true
                break
            }
        }
    }
    if (-not $updated) { throw "Automatic update from 1.3.4 to $expectedVersion did not complete and restart without login." }
    Write-Host "Automatic update from 1.3.4 to $expectedVersion completed and restarted without login."
} finally {
    if (Test-Path $application) { Write-Host "Final installed version: $((Get-Item $application).VersionInfo.ProductVersion)" }
    Get-Process 'AuthGate-IP-Agent' -ErrorAction SilentlyContinue | Select-Object Id, Path | Format-Table | Out-String | Write-Host
    foreach ($file in @('stdout.log', 'stderr.log')) {
        $logFile = Join-Path $root $file
        if (Test-Path $logFile) { Get-Content $logFile -Tail 100 | Write-Host }
    }
    Get-Process 'AuthGate-IP-Agent' -ErrorAction SilentlyContinue | Stop-Process -Force
}
