param(
  # 音乐文件夹的绝对路径（LyricFlow 的 MUSIC_PATH）
  [Parameter(Mandatory = $true)]
  [string]$MusicPath
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

if (-not (Test-Path -LiteralPath $MusicPath -PathType Container)) {
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
$global:LASTEXITCODE = 0
& $VenvPython -m src.main 2>&1 | ForEach-Object { "$_" }
$code = $global:LASTEXITCODE
Write-Output "LYRICFLOW-EXIT $code"
exit $code
