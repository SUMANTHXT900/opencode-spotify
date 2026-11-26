param(
  [switch]$Install,
  [switch]$Repair,
  [switch]$Uninstall,
  [switch]$ResetCredentials,
  [switch]$Yes,
  [switch]$SkipApply,
  [switch]$DryRun,
  [string]$SpicetifyPath = ''
)
$ErrorActionPreference = 'Stop'
if (@($Install, $Repair, $Uninstall | Where-Object { $_ }).Count -gt 1) { throw 'Choose one operation.' }
if ($ResetCredentials -and -not ($Install -or $Repair)) { throw '-ResetCredentials requires -Install or -Repair.' }
$spicetifyCommand = 'spicetify'
if ($SpicetifyPath -and $SpicetifyPath.Trim()) { $spicetifyCommand = $SpicetifyPath.Trim() }
if (-not (Get-Command $spicetifyCommand -ErrorAction SilentlyContinue)) { throw 'Spicetify not found. Install/configure it manually first.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node >=22.18 is required.' }
$config = (& $spicetifyCommand -c | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Cannot locate Spicetify configuration.' }
$directory = Join-Path (Split-Path $config) 'Extensions'
$name = 'opencode-spotify-bridge.js'
$target = Join-Path $directory $name
$source = Join-Path $PSScriptRoot "../spicetify/$name"
$helper = Join-Path $PSScriptRoot '../dist/scripts/provision.js'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { $helper = Join-Path $PSScriptRoot 'provision.ts' }
$lines = @(Get-Content -LiteralPath $config)
$registrations = @($lines | Where-Object { $_ -match '^\s*extensions\s*=' })
if ($registrations.Count -gt 1) { throw 'Ambiguous extension configuration; review duplicate extensions keys first.' }
$registered = $registrations | Select-Object -First 1
$extensionNames = @()
if ($registered) { $extensionNames = @(($registered -split '=', 2)[1] -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Set-ExtensionsRegistration([bool]$Remove) {
  if ($Remove -and -not $registered) { return }
  $names = @($extensionNames | Where-Object { $_ -ne $name })
  if (-not $Remove) { $names += $name }
  $value = $names -join '|'
  if ($registered) {
    $updated = @($lines | ForEach-Object { if ($_ -match '^\s*extensions\s*=') { "extensions = $value" } else { $_ } })
    [System.IO.File]::WriteAllLines($config, [string[]]$updated, [System.Text.UTF8Encoding]::new($false))
  } elseif (-not $Remove) {
    $updated = [System.Collections.Generic.List[string]]::new()
    $inserted = $false
    foreach ($line in $lines) {
      $updated.Add($line)
      if ($line -match '^\s*\[AdditionalOptions\]\s*$') { $updated.Add("extensions = $value"); $inserted = $true }
    }
    if (-not $inserted) { $updated.Add('[AdditionalOptions]'); $updated.Add("extensions = $value") }
    [System.IO.File]::WriteAllLines($config, $updated, [System.Text.UTF8Encoding]::new($false))
  }
  $verified = (Select-String -LiteralPath $config -Pattern '^\s*extensions\s*=').Line
  if (($verified -split '=', 2)[1].Trim() -ne $value) { throw 'Registration verification failed; restore backup if needed.' }
}
Write-Host "Config: $config"
Write-Host "Extension target: $target"
Write-Host "Existing copy: $(Test-Path -LiteralPath $target)"
Write-Host 'Unrelated extensions will be preserved. No credentials are displayed.'
$legacy = @($extensionNames | Where-Object {
  $_ -ne $name -and (Test-Path -LiteralPath (Join-Path $directory $_) -PathType Leaf) -and
    (Select-String -LiteralPath (Join-Path $directory $_) -SimpleMatch '127.0.0.1:18765' -Quiet)
})
if ($legacy.Count) { throw "Other registered extensions reference this bridge port: $($legacy -join ', '). Review duplicate bridge copies manually." }
if (-not ($Install -or $Repair -or $Uninstall)) { Write-Host 'Inspection only. Use -Install, -Repair, or -Uninstall to request approval.'; exit }
if ((Get-Item -LiteralPath $config).LinkType -or ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).LinkType)) { throw 'Refusing symbolic-link configuration or extension.' }
if ($Uninstall -and (Test-Path -LiteralPath $target) -and -not (Select-String -LiteralPath $target -SimpleMatch 'OpenCode Spotify V0.4 maintained extension' -Quiet)) { throw 'Unrecognized development bridge; refusing to remove it.' }
$operation = if ($Uninstall) { 'uninstall' } else { 'back up and replace/install this bridge' }
if ($DryRun) {
  Write-Host "Dry run: would $operation."
  Write-Host "Config: $config"
  Write-Host "Extension target: $target"
  Write-Host "Spicetify command: $spicetifyCommand"
  Write-Host 'No files were changed.'
  exit
}
if (-not $Yes) {
  if ((Read-Host "Approve $operation (including any existing development copy)? Type YES") -cne 'YES') { exit }
  if ($ResetCredentials -and (Read-Host 'Rotate credentials? All running OpenCode sessions must restart. Type RESET') -cne 'RESET') { exit }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
function Protect-UserFile([string]$Path) {
  if ($IsWindows) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $Path '/inheritance:r' '/grant:r' "${identity}:(F)" 'SYSTEM:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict credential file permissions.' }
  } else {
    & chmod 600 $Path
    if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict credential file permissions.' }
  }
}
# D14: an uninstall must never create new backup copies. Install/repair keep the
# timestamped rollback copies; uninstall deletes only and creates nothing.
$configBackup = "$config.spotify-backup-$stamp"
$extensionBackup = "$target.backup-$stamp"
$hadTarget = Test-Path -LiteralPath $target
$secretBackups = @()
if (-not $Uninstall) {
  Copy-Item -LiteralPath $config -Destination $configBackup
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  # L8: the extension copy embeds the signing secret, so restrict it immediately
  # (same ACL as the live files) instead of waiting until provisioning succeeds.
  if ($hadTarget) {
    Copy-Item -LiteralPath $target -Destination $extensionBackup
    Protect-UserFile $extensionBackup
  }
}
$root = if ($IsWindows) { Join-Path ($env:APPDATA ?? (Join-Path $HOME 'AppData\Roaming')) 'opencode-spotify' } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode-spotify' } else { Join-Path $HOME '.config/opencode-spotify' }
$credentialPath = Join-Path $root 'bridge.json'
$credentialBackup = "$credentialPath.backup-$stamp"
if (-not $Uninstall) {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if ((Get-Item -LiteralPath $root).LinkType) { throw 'Refusing symbolic-link credential directory.' }
  if ($IsWindows) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $root '/inheritance:r' '/grant:r' "${identity}:(OI)(CI)(F)" 'SYSTEM:(OI)(CI)(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict configuration directory permissions.' }
  } else { & chmod 700 $root; if ($LASTEXITCODE -ne 0) { throw 'Cannot protect configuration directory.' } }
  if (Test-Path -LiteralPath $credentialPath) {
    Protect-UserFile $credentialPath
    if ($ResetCredentials) {
      Copy-Item -LiteralPath $credentialPath -Destination $credentialBackup
      Protect-UserFile $credentialBackup
    }
  }
  $reset = if ($ResetCredentials) { 'reset' } else { 'reuse' }
  # L1: build the extension beside the live target, verify it, and only then
  # move it into place and update the extensions registration. A syntax failure
  # leaves the previous extension and registration untouched.
  # Keep a .js suffix so `node --check` parses it as the extension it will be.
  $pending = "$target.pending-$stamp.js"
  $installed = $false
  try {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
    & node $helper install $pending $reset $source
    if ($LASTEXITCODE -ne 0) { throw 'Provisioning failed. Re-run -Repair; existing backups are preserved.' }
    Protect-UserFile $pending
    & node --check $pending
    if ($LASTEXITCODE -ne 0) { throw 'Installed extension syntax check failed; configuration and the existing registration were not changed.' }
    Move-Item -LiteralPath $pending -Destination $target -Force
    $installed = $true
    Protect-UserFile $target
    Protect-UserFile $credentialPath
    Set-ExtensionsRegistration $false
  } catch {
    if (Test-Path -LiteralPath $configBackup) { Copy-Item -LiteralPath $configBackup -Destination $config -Force }
    # A failed rotation must not pair a new secret with the old live extension.
    if ($ResetCredentials -and (Test-Path -LiteralPath $credentialBackup)) {
      Copy-Item -LiteralPath $credentialBackup -Destination $credentialPath -Force
      Protect-UserFile $credentialPath
    }
    if ($installed) {
      if ($hadTarget -and (Test-Path -LiteralPath $extensionBackup)) {
        Copy-Item -LiteralPath $extensionBackup -Destination $target -Force
        Protect-UserFile $target
      } elseif (-not $hadTarget -and (Test-Path -LiteralPath $target)) {
        Remove-Item -LiteralPath $target -Force
      }
    }
    throw
  } finally {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
  }
} else {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }
  if (Test-Path -LiteralPath $credentialPath) {
    & node $helper uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Cannot mark extension uninstalled.' }
  }
  Set-ExtensionsRegistration $true
  # L8: earlier installs may have left secret-bearing rollback copies. This
  # uninstall creates none; verify what remains, protect it and disclose it.
  if (Test-Path -LiteralPath $directory) {
    $secretBackups += @(Get-ChildItem -LiteralPath $directory -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "$name.backup-*" } | ForEach-Object { $_.FullName })
  }
  if (Test-Path -LiteralPath $root) {
    $secretBackups += @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'bridge.json.backup-*' } | ForEach-Object { $_.FullName })
  }
  foreach ($backupFile in $secretBackups) { Protect-UserFile $backupFile }
}
if (-not $Uninstall) {
  Write-Host "Backups: .spotify-backup-$stamp (config), .backup-$stamp (extension)."
  if ($ResetCredentials) { Write-Host "Credential backup: $credentialPath.backup-$stamp contains the signing secret; delete it when you no longer need a rollback." }
} else {
  if ($secretBackups.Count -gt 0) {
    Write-Host "Secret-bearing rollback copies were kept: $($secretBackups -join '; ')."
    Write-Host 'These copies contain the previous signing secret; delete them once rollback is no longer needed.'
  }
  Write-Host 'No new config, extension or credential backup copies were created for this uninstall.'
}
if ($SkipApply) { if ($Uninstall) { Write-Host 'Bridge removed from files/configuration; run spicetify apply to finish removing it from the running Spotify client.' } else { Write-Host 'Files prepared; run spicetify apply when ready. The old running extension remains active until applied.' } }
elseif ($Yes) {
  & $spicetifyCommand apply
  if ($LASTEXITCODE -ne 0) { throw 'Spicetify apply failed. Repair files are ready; retry apply after reviewing the error.' }
}
elseif ((Read-Host 'Apply Spicetify changes (may restart Spotify)? Type YES') -ceq 'YES') {
  & $spicetifyCommand apply
  if ($LASTEXITCODE -ne 0) { throw 'Spicetify apply failed. Repair files are ready; retry apply after reviewing the error.' }
} else { Write-Host 'Files prepared; run spicetify apply when ready. The old running extension remains active until applied.' }
Write-Host 'Setup complete. Launch Spotify and OpenCode; authentication and runtime Origin verification are automatic.'
Write-Host 'Rollback: restore timestamped config/extension backups (and credential backup after reset), then approve spicetify apply.'
