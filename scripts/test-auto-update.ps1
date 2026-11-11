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
    # Job logs require a GitHub login; annotations are public, so publish diagnostics there too.
    function Publish-Diagnostic([string] $Title, [string[]] $Lines) {
        $text = (($Lines | Where-Object { $_ -ne $null }) -join "`n")
        if (-not $text) { $text = '(empty)' }
        if ($text.Length -gt 6000) { $text = $text.Substring($text.Length - 6000) }
        $text = $text.Replace('%', '%25').Replace("`r", '').Replace("`n", '%0A')
        Write-Host "::warning title=${Title}::${text}"
    }
    $summary = @()
    if (Test-Path $application) { $summary += "Final installed version: $((Get-Item $application).VersionInfo.ProductVersion)" } else { $summary += 'Application executable missing.' }
    $summary += "Expected version: $expectedVersion"
    $summary += (Get-Process 'AuthGate-IP-Agent' -ErrorAction SilentlyContinue | ForEach-Object { "Process $($_.Id): $($_.Path)" })
    $summary += (Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like '*AuthGate*' } | ForEach-Object { "Uninstall entry: $($_.DisplayName) $($_.DisplayVersion) at $($_.InstallLocation)" })
    $summary += (Get-ChildItem $root -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object { "File: $($_.FullName)" })
    $updaterCache = Join-Path $env:LOCALAPPDATA 'authgate-ip-updater-updater'
    $summary += (Get-ChildItem $updaterCache -Recurse -ErrorAction SilentlyContinue | ForEach-Object { "Updater cache: $($_.FullName) ($($_.Length))" })
    Write-Host ($summary -join "`n")
    Publish-Diagnostic 'Update summary' $summary
    foreach ($logFile in @((Join-Path $root 'stdout.log'), (Join-Path $root 'stderr.log'), (Join-Path $env:TEMP 'AuthGate-IP-Agent-install.log'))) {
        if (Test-Path $logFile) {
            $content = @(Get-Content $logFile -Tail 80)
            $content | Write-Host
            Publish-Diagnostic (Split-Path $logFile -Leaf) $content
        }
    }
    Get-Process 'AuthGate-IP-Agent' -ErrorAction SilentlyContinue | Stop-Process -Force
}
