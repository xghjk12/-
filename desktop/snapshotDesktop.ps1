# 轻音播放 · 桌面快照（实验用）：全屏截图 + 所有可见顶层窗口转储
#
# 用途：checkDirectoryPicker.js 在 showDirectoryPicker 挂起期间调用，
# 回答一个问题：屏幕上到底有没有弹出目录选择对话框（Chromium 在 Windows 上
# 的 FS Access 目录选择可能走 WinRT FolderPicker，窗口类不是 #32770，
# 属于别的进程，所以要用 EnumWindows 全量转储而不是只找 #32770）。
#
# 输出：
#   截图存到 $env:QY_SHOT_PATH
#   stdout 每行一个窗口：class | pid | proc | rect | title
#
# 注意（坑 5）：UTF-8 带 BOM。

param(
  [int]$TimeoutMs = 8000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class QyWinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public static List<string> Result = new List<string>();
  public static bool Callback(IntPtr h, IntPtr l) {
    if (IsWindowVisible(h)) {
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.Length > 0) {
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        Result.Add(c.ToString() + "|" + pid + "|RECT " + r.L + "," + r.T + "," + r.R + "," + r.B + "|" + t.ToString());
      }
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

# 全屏截图（先截再列窗口，避免列表耗时改变画面）
$shotPath = $env:QY_SHOT_PATH
if ($shotPath) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("SHOT: " + $shotPath + " " + $vs.Width + "x" + $vs.Height)
}

$wins = [QyWinEnum]::Enumerate()
foreach ($line in $wins) {
  $parts = $line -split '\|'
  $proc = ''
  try { $proc = (Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue).ProcessName } catch {}
  Write-Output ("WINDOW: [" + $parts[0] + "] pid=" + $parts[1] + " proc=" + $proc + " " + $parts[2] + " title=[" + $parts[3] + "]")
}
Write-Output 'RESULT: snapshotted'
exit 0
