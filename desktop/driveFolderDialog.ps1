# 轻音播放 · 原生「选择文件夹」对话框驱动（实验用，v4 = 定稿版）
#
# 用途：checkDirectoryPicker.js 里，Playwright 点击应用的「选择音乐文件夹」按钮后，
# Chromium 会弹出 Windows 原生目录选择对话框（类 #32770，标题「选择允许此网站
# 查看的文件夹」，属于一个 electron 工具进程）。Playwright 只能驱动网页 DOM，
# 够不到这个原生对话框，所以这个脚本代劳。
#
# 四个版本踩出来的经验（都写下来，换机器排障时不用再猜）：
#   1. 对话框确实会弹，但 **UI Automation 的 RootElement.Children 枚举看不到它**
#      （owned window），必须用 user32 EnumWindows 找。
#   2. 对话框属于一个 electron 工具进程——不是拥有主窗口的浏览器进程，
#      也不是 Playwright 报的那个 pid；按 pid/命令行过滤全都匹配不上。
#   3. 这个对话框是经典 Win32 通用对话框，**UIA 的 ControlType 全都谎报成 Pane**
#      （编辑框、按钮都是），按 ControlType.Edit / ControlType.Button 找不到；
#      正确姿势是按 ClassName + AutomationId 找（见下面第 4 条）。
#   4. 实测控件（Windows 10，中文系统）：
#        路径编辑框：ClassName=Edit, 控件 ID 1152（0x480，经典对话框的 edt1）
#        确认按钮：  Name=选择文件夹, ClassName=Button, 控件 ID 1（IDOK）
#        取消按钮：  Name=取消, ClassName=Button, 控件 ID 2（IDCANCEL）
#        「文件夹:」标签：ClassName=Static, 控件 ID 1090
#      路径框直接填绝对路径、点 IDOK 即可，不需要 Alt+D 键盘导航
#      （实测 Alt+D 会把路径敲到别处，还可能弹出别的子对话框）。
#   5. **驱动必须用纯 Win32 消息**（UIA 的 ValuePattern / InvokePattern 在这个
#      对话框上全部不可用）：EnumChildWindows 找 HWND → WM_SETTEXT 填路径 →
#      补一条 WM_COMMAND(EN_CHANGE) 通知（WM_SETTEXT 不触发 EN_CHANGE，不补的话
#      OK 按钮可能还是灰的）→ BM_CLICK 点 IDOK。若对话框还在，回退真实鼠标点击
#      按钮中心。
#
# 注意（坑 5）：本文件必须存成 UTF-8 带 BOM，否则 powershell.exe 5.1 会按 ANSI
# 解码，中文注释会把引号"吃掉"导致解析失败。

param(
  [int]$WatchSec = 55
)

$ErrorActionPreference = 'Stop'

$folder = $env:QINGYIN_PICK_PATH
if (-not $folder) { Write-Output 'RESULT: no-path'; exit 2 }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
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
        Result.Add(c.ToString() + "|" + pid + "|" + r.L + "," + r.T + "," + r.R + "," + r.B + "|" + t.ToString() + "|" + h.ToInt64());
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
Add-Type -Namespace QyNative -Name User32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
'@
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class QyDlg {
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public static List<IntPtr> Children = new List<IntPtr>();
  public static bool ChildCb(IntPtr h, IntPtr l) { Children.Add(h); return true; }
  public static List<IntPtr> Enumerate(IntPtr parent) {
    Children.Clear();
    EnumChildWindows(parent, ChildCb, IntPtr.Zero);
    return Children;
  }
}
"@

$script:start = Get-Date
function Stamp {
  '{0,7:F1}s ' -f ((Get-Date) - $script:start).TotalSeconds
}

$script:procNameCache = @{}
function ProcNameOf {
  param([int]$ProcId)
  if ($script:procNameCache.ContainsKey($ProcId)) { return $script:procNameCache[$ProcId] }
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  $name = if ($p) { $p.ProcessName } else { '(gone)' }
  $script:procNameCache[$ProcId] = $name
  return $name
}

$deadline = (Get-Date).AddSeconds($WatchSec)
$seen = @{}
$dialogHwnd = [IntPtr]::Zero
$dialogPid = 0

while ((Get-Date) -lt $deadline) {
  $wins = [QyWinEnum]::Enumerate()
  foreach ($line in $wins) {
    $parts = $line -split '\|'
    $class = $parts[0]
    $ownerPid = [int]$parts[1]
    $rect = $parts[2]
    $title = $parts[3]
    $hwnd = [IntPtr]([int64]$parts[4])
    $procName = ProcNameOf $ownerPid
    $interesting =
      ($class -eq '#32770') -or
      ($procName -match 'electron') -or
      ($title -match '选择|文件夹|folder|Folder|Select')
    if (-not $interesting) { continue }
    $key = "$class|$ownerPid|$title"
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      Write-Output ((Stamp) + "WINDOW + class=[$class] pid=$ownerPid proc=$procName rect=[$rect] title=[$title]")
    }
    if ($dialogHwnd -eq [IntPtr]::Zero -and $class -eq '#32770' -and $procName -match 'electron') {
      $dialogHwnd = $hwnd
      $dialogPid = $ownerPid
      Write-Output ((Stamp) + "DIALOG  pid=$ownerPid title=[$title]")
    }
  }
  if ($dialogHwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 400
}

if ($dialogHwnd -eq [IntPtr]::Zero) {
  Write-Output ((Stamp) + 'RESULT: dialog-not-found')
  exit 3
}

# 对话框控件是异步建出来的，稍等一下再操作
Start-Sleep -Milliseconds 800

# ---- 驱动：纯 Win32 消息（WM_SETTEXT + BM_CLICK）----
# UIA 在这个对话框上不可靠（ControlType 谎报成 Pane、ValuePattern/InvokePattern 都
# 拿不到），所以直接用 EnumChildWindows 找控件 HWND 发消息驱动：
#   路径框：class Edit，控件 ID 1152（经典对话框 edt1）→ WM_SETTEXT 填路径
#   确认键：class Button，控件 ID 1（IDOK）→ BM_CLICK
# 另外补一条 WM_COMMAND(EN_CHANGE) 通知：WM_SETTEXT 不会触发 EN_CHANGE，
# 而对话框靠它更新 OK 按钮的可用状态——不补的话按钮可能是灰的。
$editHwnd = [IntPtr]::Zero
$okHwnd = [IntPtr]::Zero
$children = [QyDlg]::Enumerate($dialogHwnd)
foreach ($ch in $children) {
  $cls = New-Object System.Text.StringBuilder(256)
  [void][QyDlg]::GetClassName($ch, $cls, 256)
  $className = $cls.ToString()
  $ctrlId = [QyDlg]::GetDlgCtrlID($ch)
  if ($className -eq 'Edit' -and $ctrlId -eq 1152) { $editHwnd = $ch }
  if ($className -eq 'Button' -and $ctrlId -eq 1) {
    $t = New-Object System.Text.StringBuilder(256)
    [void][QyDlg]::GetWindowText($ch, $t, 256)
    if ($t.ToString() -match '选择文件夹|Select Folder') { $okHwnd = $ch }
  }
}
Write-Output ((Stamp) + "CHILDREN count=$($children.Count) editFound=$($editHwnd -ne [IntPtr]::Zero) okFound=$($okHwnd -ne [IntPtr]::Zero)")
if ($editHwnd -eq [IntPtr]::Zero) { Write-Output ((Stamp) + 'RESULT: edit-not-found'); exit 4 }
if ($okHwnd -eq [IntPtr]::Zero) { Write-Output ((Stamp) + 'RESULT: ok-button-not-found'); exit 6 }

# 填路径
[void][QyDlg]::SendMessage($editHwnd, 0x000C, [IntPtr]::Zero, $folder)
Write-Output ((Stamp) + "SET wm-settext [$folder]")

# 补发 EN_CHANGE 通知（WM_COMMAND: wParam = (EN_CHANGE<<16) | 1152, lParam = editHwnd）
$wparam = [IntPtr]([int64]0x03000480)
[void][QyDlg]::SendMessage($dialogHwnd, 0x0111, $wparam, $editHwnd)
Write-Output ((Stamp) + 'SET en-change-notify')

Start-Sleep -Milliseconds 600

# 读回验证 + 按钮可用性
$readback = New-Object System.Text.StringBuilder(512)
[void][QyDlg]::GetWindowText($editHwnd, $readback, 512)
Write-Output ((Stamp) + "EDIT-READBACK [$($readback.ToString())]")
$okEnabled = [QyDlg]::IsWindowEnabled($okHwnd)
Write-Output ((Stamp) + "OK-ENABLED $okEnabled")

# 点「选择文件夹」按钮（BM_CLICK）
[void][QyDlg]::SendMessage($okHwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output ((Stamp) + 'SET bm-click-ok')

Start-Sleep -Milliseconds 1500
# 若对话框还在（BM_CLICK 没生效——按钮被禁用之类），回退：置前后真实鼠标点按钮中心
$stillOpenNow = $false
foreach ($line in [QyWinEnum]::Enumerate()) {
  $parts = $line -split '\|'
  if ($parts[0] -eq '#32770' -and [int]$parts[1] -eq $dialogPid) { $stillOpenNow = $true }
}
if ($stillOpenNow) {
  Write-Output ((Stamp) + 'NOTE dialog-open-after-bm-click，回退真实鼠标点击')
  $r = $null
  $okElement = [System.Windows.Automation.AutomationElement]::FromHandle($okHwnd)
  try { $r = $okElement.Current.BoundingRectangle } catch {}
  if ($r -and $r.Width -gt 0) {
    $cx = [int]($r.X + $r.Width / 2)
    $cy = [int]($r.Y + $r.Height / 2)
    [QyNative.User32]::SetForegroundWindow($dialogHwnd) | Out-Null
    Start-Sleep -Milliseconds 200
    [QyNative.User32]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 120
    [QyNative.User32]::mouse_event(0x00000002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [QyNative.User32]::mouse_event(0x00000004, 0, 0, 0, [UIntPtr]::Zero)
    Write-Output ((Stamp) + "SET mouse-click ($cx,$cy)")
  } else {
    [QyNative.User32]::SetForegroundWindow($dialogHwnd) | Out-Null
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Write-Output ((Stamp) + 'SET sendkeys-enter-fallback')
  }
}

Write-Output ((Stamp) + 'RESULT: drove')

# 确认之后再看 3 秒：对话框应当消失
Start-Sleep -Milliseconds 3000
$wins = [QyWinEnum]::Enumerate()
$stillOpen = $false
foreach ($line in $wins) {
  $parts = $line -split '\|'
  if ($parts[0] -eq '#32770' -and [int]$parts[1] -eq $dialogPid) { $stillOpen = $true }
}
if ($stillOpen) { Write-Output ((Stamp) + 'NOTE dialog-still-open') }
Write-Output ((Stamp) + 'WATCH end')
exit 0
