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

# DSH 主目录不一定是 %USERPROFILE%\.dsh —— 本机就被改道到了 D 盘（DSH_HOME=D:\.dsh）。
# 以前这里硬写 $env:USERPROFILE\.dsh，于是文件被复制到 C 盘那个同名目录，
# 运行中的应用读的却是 D 盘这份：源文件改了半天，界面一点变化都没有，
# 而且不报任何错（复制「成功」了）。
#
# 取值顺序：DSH_HOME（宿主真实在用的那个）→ %USERPROFILE%\.dsh（默认布局兜底）。
$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dst = Join-Path $home_ 'profiles\desktop\node_modules\dsh-ops-board'

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\index.js", "$src\client.js", "$src\package.json", "$src\cordis.patch.yml", "$src\icon.svg", "$src\README.md" -Destination $dst -Force
foreach ($dir in @('locale', 'test')) {
  if (Test-Path (Join-Path $src $dir)) {
    Copy-Item (Join-Path $src $dir) -Destination $dst -Recurse -Force
  }
}

Write-Host "synced -> $dst"
Write-Host "host half hot-reloads at /ops-board/state; client half needs Ctrl+R (or HMR) to reload."
