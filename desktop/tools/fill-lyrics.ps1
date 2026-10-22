param(
  # 音乐文件夹的绝对路径（LyricFlow 的 MUSIC_PATH）
  [string]$MusicPath,

  # 自检模式：只验证工具链是否齐备（venv / src/main.py / 可导入），不联网、不下载。
  # 给自动化用——真实跑一次要访问歌词接口，不适合放进回归。
  [switch]$Preflight,

  # 端到端自检（不联网）：用一个**空临时目录**当 MUSIC_PATH，走完整调用路径。
  # 曲库为空 → LyricFlow 扫 0 首 → 不发任何网络请求 → 退出 0。
  # 这条能覆盖两个真实故障：cwd 没切（No module named src.main）与
  # $ErrorActionPreference='Stop' 撞上 stderr 日志（跑一下就退出 1）。
  [switch]$SelfTest
)

# t5 内置补歌词工具：用 artifacts\lyricflow 的 venv python 跑 LyricFlow。
#
# 约定（desktop/lyricsTool.js 依赖）：
#  - 退出码 0 = 成功；2 = venv/python 缺失（给出安装指引）；3 = MusicPath 无效；其他 = LyricFlow 自身的退出码
#  - stdout/stderr 全部回传（主进程收日志尾）；输出统一 UTF-8（[Console]::OutputEncoding + PYTHONIOENCODING）
#
# 注意：artifacts/ 在 .gitignore 里，新克隆的仓库没有这个目录——所以缺失是**正常路径**，
# 必须给出"怎么装"的指引而不是一句冷冰冰的报错。
#
# 参数口径来自仓库根 README.md「给整个曲库补歌词」一节实测过的那套环境变量。

$ErrorActionPreference = 'Stop'
# 让重定向到管道的输出按 UTF-8 编码（默认走 OEM 代码页，中文会变乱码）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# LyricFlow 的日志输出也强制 UTF-8
$env:PYTHONIOENCODING = 'utf-8'

# 脚本位置 = desktop\tools\fill-lyrics.ps1 → 仓库根 = ..\..
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ToolRoot = Join-Path $RepoRoot 'artifacts\lyricflow'
$VenvPython = Join-Path $ToolRoot '.venv\Scripts\python.exe'
$MainModule = Join-Path $ToolRoot 'src\main.py'

function Fail([int]$Code, [string]$Message) {
  # 指引写到 stderr（主进程收日志尾并展示），退出码如实
  [Console]::Error.WriteLine($Message)
  exit $Code
}

if ($Preflight) {
  # 只跑到"能 import 到 src.main"为止：不联网、不写任何文件。
  # 这条是为了让"脚本自己能不能跑"进得了回归——真实下载没法自动化。
  Push-Location -LiteralPath $ToolRoot
  try {
    & $VenvPython -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('src.main') else 9)"
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) {
    Fail 2 "自检失败：在 $ToolRoot 下找不到可导入的 src.main（退出码 $code）"
  }
  Write-Output 'PREFLIGHT-OK'
  exit 0
}

$SelfTestDir = $null
if ($SelfTest -and -not $MusicPath) {
  # 空临时目录：曲库为 0 首 → 不触发任何网络请求，但完整走一遍 cwd / 编码 / 退出码路径
  $SelfTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qingyin-selftest-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $SelfTestDir | Out-Null
  $MusicPath = $SelfTestDir
  Write-Output "SELFTEST-MUSIC $MusicPath"
}

if (-not $MusicPath -or -not (Test-Path -LiteralPath $MusicPath -PathType Container)) {
  Fail 3 "MUSIC_PATH 不是有效目录：$MusicPath"
}

if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
  Fail 2 @"
找不到 LyricFlow 的 Python：$VenvPython

LyricFlow 是外部工具（github.com/laoning666/lyricFlow，CC BY-NC 4.0），
仓库默认把它放在 artifacts\lyricflow（此目录不进 git）。安装步骤：

  1. 取源码（本机 github.com 直连不通时走 CDN 镜像）：
     https://cdn.jsdelivr.net/gh/laoning666/lyricFlow@main/<路径>
     下载后解压到 D:\轻音播放\artifacts\lyricflow（含 src\ 目录）
  2. 建 venv 并装依赖（只要两个包）：
     cd artifacts\lyricflow
     python -m venv .venv
     .venv\Scripts\pip install httpx mutagen
  3. 再点一次托盘的「补歌词…」即可。

详细说明见仓库根 README.md「给整个曲库补歌词」一节。
"@
}

if (-not (Test-Path -LiteralPath $MainModule -PathType Leaf)) {
  Fail 2 "LyricFlow 安装不完整：找不到 $MainModule（需要完整源码，不只是 venv）"
}

Write-Output "LYRICFLOW-PYTHON $VenvPython"
Write-Output "MUSIC-PATH $MusicPath"

# 实测过的参数（README）：lrcapi + api.lrc.cx；只存外部 .lrc，一律不改音频元数据
$env:MUSIC_PATH        = $MusicPath
$env:API_PROVIDER      = 'lrcapi'
$env:LRCAPI_URL        = 'https://api.lrc.cx'
$env:DOWNLOAD_COVER    = 'false'
$env:OVERWRITE_LYRICS  = 'false'
$env:UPDATE_LYRICS     = 'false'
$env:UPDATE_COVER      = 'false'
$env:UPDATE_BASIC_INFO = 'false'
$env:SCAN_INTERVAL_DAYS = '0'

# 在工具根目录以模块方式跑（src/main.py 用相对导入，必须 -m src.main）
#
# 注意 **cwd 必须是 $ToolRoot**：真实故障——之前只写了这句注释、没切目录，
# python 在仓库根找不到 `src` 包，直接 `No module named src.main` 退出 1。
# 而 E2E 用的是假工具，正好覆盖不到这里（见 desktop/README.md 坑 15）。
$global:LASTEXITCODE = 0
# LyricFlow 的日志走 **stderr**，而脚本顶部设了 $ErrorActionPreference='Stop'——
# 在 Stop 下 PowerShell 把第一条 stderr 当成**终止错误**，脚本"刚开始就退出 1"，
# 真正的业务日志一条都传不出来。这是第二个真实故障（第一个是 cwd）。
# 这里临时放开，让日志能进管道。
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location -LiteralPath $ToolRoot
try {
  & $VenvPython -m src.main 2>&1 | ForEach-Object { "$_" }
  $code = $global:LASTEXITCODE
} finally {
  Pop-Location
  $ErrorActionPreference = $previousEap
}
Write-Output "LYRICFLOW-EXIT $code"
if ($SelfTestDir) {
  Remove-Item -Recurse -Force -LiteralPath $SelfTestDir -ErrorAction SilentlyContinue
}
exit $code
