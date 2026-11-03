$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release/AuthGate-IP-Agent-Setup-$version.exe").Path
$testRoot = Join-Path $env:RUNNER_TEMP 'authgate-installer-smoke'
$installDirectory = Join-Path $testRoot 'app'
$helperDirectory = Join-Path $testRoot 'app-helper'
$application = Join-Path $installDirectory 'AuthGate-IP-Agent.exe'
$legacyApplication = Join-Path $installDirectory 'AuthGate Atualizador de IP.exe'
$uninstaller = Join-Path $installDirectory 'Uninstall AuthGate-IP-Agent.exe'
$helper = $null

function Run-Setup([string] $File, [string] $Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(120000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw 'Installer did not complete within 120 seconds.'
    }
    if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
}

function Install-Current {
    Run-Setup $installer "/S /D=$installDirectory"
    if (-not (Test-Path $application)) { throw 'Installed application is missing.' }
}

try {
    New-Item -ItemType Directory -Force $testRoot | Out-Null
    # Exercise the actual old uninstaller during the executable-name migration.
    $legacyInstaller = Join-Path $testRoot 'legacy-setup.exe'
    Invoke-WebRequest 'https://github.com/TropaDigital/AUTHGATE-IP-UPDATER/releases/download/v1.3.1/AuthGate-Atualizador-de-IP-Setup-1.3.1.exe' -OutFile $legacyInstaller
    Run-Setup $legacyInstaller "/S /D=$installDirectory"
    if (-not (Test-Path $legacyApplication)) { throw 'Legacy installation failed.' }
    Install-Current
    if (Test-Path $legacyApplication) { throw 'Legacy application was not replaced.' }
    Write-Host 'Migration from the previous executable name passed.'

    New-Item -ItemType Directory -Force $helperDirectory | Out-Null
    # Reproduce the broad StartsWith match without locking installed files.
    Copy-Item "$env:SystemRoot\System32\cmd.exe" (Join-Path $helperDirectory 'authgate-helper.exe')
    $helper = Start-Process -FilePath (Join-Path $helperDirectory 'authgate-helper.exe') -ArgumentList '/d /c ping -t 127.0.0.1 > nul' -PassThru -WindowStyle Hidden
    Install-Current
    if ($helper.HasExited) { throw 'The installer closed an unrelated helper process.' }
    if (-not (Test-Path $uninstaller)) { throw 'Uninstaller is missing.' }
    Run-Setup $uninstaller '/S'
    # Uninstall copies itself into temp; wait for its child to finish.
    for ($i = 0; $i -lt 30 -and (Test-Path $application); $i++) { Start-Sleep -Seconds 1 }
    if (Test-Path $application) { throw 'Uninstall did not remove the application.' }
    Install-Current
    if ($helper.HasExited) { throw 'The fresh installer closed an unrelated helper process.' }
    Write-Host 'Fresh install, reinstall and uninstall passed with an unrelated process sharing the directory prefix.'
    Run-Setup $uninstaller '/S'
} finally {
    if ($helper -and -not $helper.HasExited) {
        & taskkill /PID $helper.Id /T /F | Out-Null
    }
}
