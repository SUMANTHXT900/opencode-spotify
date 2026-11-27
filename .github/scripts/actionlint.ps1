param(
  [string]$CacheDir = $env:ACTIONLINT_CACHE_DIR
)
$ErrorActionPreference = 'Stop'

# Verified against the Windows x64 asset digest in the upstream release.
$version = '1.7.12'
$sha256 = '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$exitCode = 1

if ([string]::IsNullOrWhiteSpace($CacheDir)) {
  $CacheDir = $null
} else {
  $CacheDir = $CacheDir.Trim()
}

# Cache-friendly mode (CI): reuse the cached binary when present so the
# actions/cache restore skips the download entirely. Otherwise download,
# verify, and extract into the cache dir, preserving actionlint.exe there
# for the next cache save.
if ($CacheDir) {
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $exe = Join-Path $CacheDir 'actionlint.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    $tmpZip = Join-Path ([IO.Path]::GetTempPath()) ("actionlint-" + $version + "-" + [guid]::NewGuid().ToString('N') + ".zip")
    try {
      $url = "https://github.com/rhysd/actionlint/releases/download/v$version/actionlint_${version}_windows_amd64.zip"
      Invoke-WebRequest -Uri $url -OutFile $tmpZip -TimeoutSec 60
      if ((Get-FileHash -LiteralPath $tmpZip -Algorithm SHA256).Hash -ne $sha256) {
        throw 'actionlint release SHA-256 mismatch'
      }
      Expand-Archive -LiteralPath $tmpZip -DestinationPath $CacheDir -Force
    } finally {
      if (Test-Path -LiteralPath $tmpZip) { Remove-Item -LiteralPath $tmpZip -Force }
    }
  }

  Push-Location $root
  try {
    # Check Actions syntax, expressions, action inputs, and reusable workflows.
    # The Windows runner does not provision ShellCheck or Pyflakes.
    & $exe -shellcheck= -pyflakes=
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  exit $exitCode
}

# Default local mode: scratch dir + cleanup so local runs stay clean.
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("opencode-actionlint-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  $zip = Join-Path $scratch 'actionlint.zip'
  $url = "https://github.com/rhysd/actionlint/releases/download/v$version/actionlint_${version}_windows_amd64.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 60
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $sha256) {
    throw 'actionlint release SHA-256 mismatch'
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $scratch

  Push-Location $root
  try {
    # Check Actions syntax, expressions, action inputs, and reusable workflows.
    # The Windows runner does not provision ShellCheck or Pyflakes.
    & (Join-Path $scratch 'actionlint.exe') -shellcheck= -pyflakes=
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force
}
exit $exitCode
