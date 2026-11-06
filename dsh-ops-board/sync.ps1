# sync.ps1 — copy this package into the desktop profile.
#
# The desktop profile needs a REAL directory (a junction/link trips the
# PROFILE_UPGRADE_REQUIRED gate), so this deliberately copies instead of
# linking. Run it after editing index.js / client.js / locale files:
#
#   pwsh -File .\sync.ps1
#
# The Host half is hot-applied by the loader; the Client half is picked up on
# the next page boot (Ctrl+R) or, when HMR sees the changed bundle, live.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-ops-board'

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\index.js", "$src\client.js", "$src\package.json", "$src\cordis.patch.yml", "$src\icon.svg", "$src\README.md" -Destination $dst -Force
foreach ($dir in @('locale', 'test')) {
  if (Test-Path (Join-Path $src $dir)) {
    Copy-Item (Join-Path $src $dir) -Destination $dst -Recurse -Force
  }
}

Write-Host "synced -> $dst"
Write-Host "host half hot-reloads at /ops-board/state; client half needs Ctrl+R (or HMR) to reload."
