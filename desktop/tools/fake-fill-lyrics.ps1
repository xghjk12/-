param(
  # 音乐文件夹的绝对路径（往这里写一个 .lrc）
  [Parameter(Mandatory = $true)]
  [string]$MusicPath,
  # 测试用：先睡这么久再写文件（验证「运行中」守卫与取消路径用）
  [int]$DelaySec = 0
)

# t5 测试用的**假**补歌词工具：在曲库里挑一首还没有同名 .lrc 的音频，
# 写一个内容确定的可读 .lrc。用来端到端验证「托盘/按钮 → running → done →
# 自动重扫 → 面板看到歌词」整条链路（desktop/checkLyricsTool.js），不碰网络。
#
# 约定与 fill-lyrics.ps1 一致：退出码 0 = 成功；3 = MusicPath 无效；4 = 没有可写的曲目；
# stdout/stderr 回传，UTF-8。接受 -MusicPath 参数（跟内置工具同一份调用约定，
# 通过 settings.json 的 lyricsToolPath 指向本文件即可替换真实工具）。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Fail([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

if (-not (Test-Path -LiteralPath $MusicPath -PathType Container)) {
  Fail 3 "MUSIC_PATH 不是有效目录：$MusicPath"
}

$audioExtensions = @('.mp3', '.flac', '.m4a', '.wav', '.ogg', '.wma', '.ape', '.strm')
# 平铺一层就够用（曲库本身就是平铺结构；真工具会递归，假工具没必要）
$files = Get-ChildItem -LiteralPath $MusicPath -File | Sort-Object Name
$target = $null
foreach ($file in $files) {
  if ($audioExtensions -contains $file.Extension.ToLowerInvariant()) {
    $lrcName = [System.IO.Path]::ChangeExtension($file.Name, '.lrc')
    if (-not (Test-Path -LiteralPath (Join-Path $MusicPath $lrcName))) {
      $target = $file
      break
    }
  }
}

if ($null -eq $target) {
  Fail 4 "曲库里找不到「还没有同名 .lrc」的音频文件：$MusicPath"
}

if ($DelaySec -gt 0) {
  Write-Output "FAKE-FILL sleeping $DelaySec s"
  Start-Sleep -Seconds $DelaySec
}

$lrcPath = [System.IO.Path]::ChangeExtension($target.FullName, '.lrc')
$content = @"
[ti:$($target.BaseName)]
[00:00.00]假工具第一句：补歌词链路通了
[00:02.00]假工具第二句：如果面板显示到这句就是全链路 OK
[00:04.00]纯文本行也算歌词
"@

# UTF-8（带 BOM，老播放器/编辑器兼容性最好；core 的 decodeLyrics 两种都认）
[System.IO.File]::WriteAllText($lrcPath, $content, (New-Object System.Text.UTF8Encoding($true)))

Write-Output "FAKE-FILL wrote $lrcPath"
Write-Output "FAKE-FILL target $($target.Name)"
exit 0
