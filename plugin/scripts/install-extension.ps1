param([switch]$Install, [switch]$Repair, [switch]$Uninstall, [switch]$ResetCredentials)
$ErrorActionPreference = 'Stop'
if (@($Install, $Repair, $Uninstall | Where-Object { $_ }).Count -gt 1) { throw 'Choose one operation.' }
if ($ResetCredentials -and -not ($Install -or $Repair)) { throw '-ResetCredentials requires -Install or -Repair.' }
if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) { throw 'Spicetify not found. Install/configure it manually first.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node >=22.18 is required.' }
$config = (& spicetify -c | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Cannot locate Spicetify configuration.' }
$directory = Join-Path (Split-Path $config) 'Extensions'
$name = 'opencode-spotify-bridge.js'
$target = Join-Path $directory $name
$source = Join-Path $PSScriptRoot "../spicetify/$name"
$helper = Join-Path $PSScriptRoot 'provision.ts'
$lines = @(Get-Content -LiteralPath $config)
$registrations = @($lines | Where-Object { $_ -match '^\s*extensions\s*=' })
if ($registrations.Count -gt 1) { throw 'Ambiguous extension configuration; review duplicate extensions keys first.' }
$registered = $registrations | Select-Object -First 1
$extensionNames = @()
if ($registered) { $extensionNames = @(($registered -split '=', 2)[1] -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
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
if ((Read-Host "Approve $operation (including any existing development copy)? Type YES") -cne 'YES') { exit }
if ($ResetCredentials -and (Read-Host 'Rotate credentials? All running OpenCode sessions must restart. Type RESET') -cne 'RESET') { exit }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
Copy-Item -LiteralPath $config -Destination "$config.spotify-backup-$stamp"
New-Item -ItemType Directory -Force -Path $directory | Out-Null
if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.backup-$stamp" }
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
$root = if ($IsWindows) { Join-Path $env:APPDATA 'opencode-spotify' } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode-spotify' } else { Join-Path $HOME '.config/opencode-spotify' }
$credentialPath = Join-Path $root 'bridge.json'
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
      Copy-Item -LiteralPath $credentialPath -Destination "$credentialPath.backup-$stamp"
      Protect-UserFile "$credentialPath.backup-$stamp"
    }
  }
  $reset = if ($ResetCredentials) { 'reset' } else { 'reuse' }
  & node $helper install $target $reset
  if ($LASTEXITCODE -ne 0) { throw 'Provisioning failed. Re-run -Repair; existing backups are preserved.' }
  Protect-UserFile $credentialPath
  Protect-UserFile $target
} else {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }
  if (Test-Path -LiteralPath $credentialPath) {
    & node $helper uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Cannot mark extension uninstalled.' }
  }
}
if (Test-Path -LiteralPath "$target.backup-$stamp") { Protect-UserFile "$target.backup-$stamp" }
$names = @($extensionNames | Where-Object { $_ -ne $name })
if (-not $Uninstall) { $names += $name }
$value = $names -join '|'
if ($registered) {
  $updated = @($lines | ForEach-Object { if ($_ -match '^\s*extensions\s*=') { "extensions = $value" } else { $_ } })
  [System.IO.File]::WriteAllLines($config, [string[]]$updated, [System.Text.UTF8Encoding]::new($false))
} elseif (-not $Uninstall) {
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
if (-not $Uninstall) {
  & node --check $target
  if ($LASTEXITCODE -ne 0) { throw 'Installed extension syntax check failed.' }
}
Write-Host "Backups: .spotify-backup-$stamp (config), .backup-$stamp (extension)."
if ((Read-Host 'Apply Spicetify changes (may restart Spotify)? Type YES') -ceq 'YES') {
  & spicetify apply
  if ($LASTEXITCODE -ne 0) { throw 'Spicetify apply failed. Repair files are ready; retry apply after reviewing the error.' }
} else { Write-Host 'Files prepared; run spicetify apply when ready. The old running extension remains active until applied.' }
Write-Host 'Setup complete. Launch Spotify and OpenCode; authentication and runtime Origin verification are automatic.'
Write-Host 'Rollback: restore timestamped config/extension backups (and credential backup after reset), then approve spicetify apply.'
