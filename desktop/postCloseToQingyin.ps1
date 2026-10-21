# 轻音播放 · 向主窗口投递 WM_CLOSE（模拟用户点窗口右上角的 X）
#
# 为什么需要它：checkTray.js 要验证"关窗到托盘（音乐继续放）"。真实用户点 X
# 走的是 Win32 WM_CLOSE 消息 → Electron 'close' 事件 → 主进程 preventDefault +
# hide。而 Playwright 在渲染进程里 evaluate `window.close()` 走的是 CDP/DevTools
# 的强制关闭路径，会直接销毁 WebContents，绕过 'close' 事件——测的不是用户路径。
#
# 匹配：顶层可见窗口，类 Chrome_WidgetWin_1，标题以「轻音播放 v」开头
# （标题带版本号，正好是主窗口的指纹），进程名 electron。
# PostMessage（异步投递）而不是 SendMessage（同步，可能被弹窗挡住）。
#
# 注意（坑 5）：本文件必须存成 UTF-8 带 BOM，否则 powershell.exe 5.1 会按 ANSI
# 解码，中文注释会把引号"吃掉"导致解析失败。

param(
  [string]$TitlePrefix = '轻音播放 v'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class QyClose {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public static List<string> Result = new List<string>();
  public static bool Callback(IntPtr h, IntPtr l) {
    if (IsWindowVisible(h)) {
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      Result.Add(c.ToString() + "|" + pid + "|" + t.ToString() + "|" + h.ToInt64());
    }
    return true;
  }
  public static List<string> Enumerate() {
    Result.Clear();
    EnumWindows(Callback, IntPtr.Zero);
    return Result;
  }
}
"@

# 注意：不能叫 $matches——那是 PowerShell 的自动变量（-match 的结果 hashtable），
# += 一个 PSCustomObject 进去会报 "hash table can only be added to another hash table"
$hits = @()
foreach ($line in [QyClose]::Enumerate()) {
  $parts = $line -split '\|'
  $class = $parts[0]
  $ownerPid = [int]$parts[1]
  $title = $parts[2]
  $hwnd = [IntPtr]([int64]$parts[3])
  if ($class -ne 'Chrome_WidgetWin_1') { continue }
  # 标题是「轻音播放 vX」或「歌名 - 轻音播放 vX」（播放中页面会改标题），
  # 所以用 Contains 而不是 StartsWith
  if (-not $title.Contains($TitlePrefix)) { continue }
  $p = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  $procName = if ($p) { $p.ProcessName } else { '(gone)' }
  if ($procName -notmatch 'electron') { continue }
  $hits += [pscustomobject]@{ Hwnd = $hwnd; Pid = $ownerPid; Title = $title }
}

if ($hits.Count -eq 0) {
  Write-Output 'RESULT: window-not-found'
  exit 4
}
if ($hits.Count -gt 1) {
  Write-Output "RESULT: ambiguous ($($hits.Count) 个窗口匹配)"
  foreach ($m in $hits) { Write-Output "  pid=$($m.Pid) title=[$($m.Title)]" }
  exit 5
}

$target = $hits[0]
# WM_CLOSE = 0x0010
$ok = [QyClose]::PostMessage($target.Hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output "RESULT: posted pid=$($target.Pid) title=[$($target.Title)] ok=$ok"
exit 0
