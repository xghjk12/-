# 轻音播放 · 桌面端启动脚本（开发/排障用）
#
# 为什么要一个脚本而不是直接敲 electron：本机有两个坑，忘了踩一个就白折腾半天——
#   1. DSH 终端会给所有子进程设 ELECTRON_RUN_AS_NODE=1，带着它 electron.exe 会退化成
#      纯 Node（require('electron').app 是 undefined），一开头就 TypeError。
#   2. 这台机器的 Chromium 沙箱初始化会直接崩（EXCEPTION_BREAKPOINT），必须 --no-sandbox。
#      注意：app.commandLine.appendSwitch('no-sandbox') 来不及，只能在命令行给。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File desktop/start.ps1
#   powershell -ExecutionPolicy Bypass -File desktop/start.ps1 -Rebuild      # 先 vite build 再启动
#   powershell -ExecutionPolicy Bypass -File desktop/start.ps1 -KeepSandbox  # 换机器时验证沙箱能不能开

param(
  [switch]$Rebuild,
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# 坑 1：别让 electron.exe 变成纯 Node
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Host '没找到 Electron 二进制，先补下：' -ForegroundColor Yellow
  Write-Host '  node desktop/installElectron.js'
  exit 1
}

$dist = Join-Path $repoRoot 'dist\index.html'
if ($Rebuild -or -not (Test-Path $dist)) {
  Write-Host '构建前端（vite build）…'
  node (Join-Path $repoRoot 'node_modules\vite\bin\vite.js') build
  if ($LASTEXITCODE -ne 0) { Write-Host 'vite build 失败' -ForegroundColor Red; exit $LASTEXITCODE }
}

$flags = @()
if (-not $KeepSandbox) { $flags += '--no-sandbox' }   # 坑 2

Write-Host "启动：$electron desktop $($flags -join ' ')"
& $electron (Join-Path $repoRoot 'desktop') @flags
exit $LASTEXITCODE
