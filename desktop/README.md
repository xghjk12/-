# desktop/ —— 轻音播放桌面端壳（探路 + t2 壳层实现成果）

t1 探路阶段证明了壳能跑起来、把 origin 定死、拿数据回答"关掉再开数据还在不在"，
以及把文件系统桥（fs 桥）的最小设计写清楚（§3.5 实测后已降级为可选优化，本期不做）。

t2 实现阶段（本版）补齐桌面壳五件套：**托盘 / 关窗到托盘（音乐继续放）/
单实例 / 开机自启 / 版本号**，全部用 `desktop/checkTray.js` 自动化验证通过
（跑法与判定见 §1 与 §3.6，全量报告 `artifacts/desktop/tray-check.json`）。

边界：没有改动 `src/core`、`src/ui`、`src/platform`，没有改 `package.json` 里任何已有脚本；
新增了一条 `"test:desktop"` 脚本（跑 `desktop/*.test.cjs` 的 43 个单测，与 test:demo 同款写法），
其余全部是 `desktop/` 下的新增/修改文件。`pnpm verify` 全绿记录见 §0。

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 壳能不能跑 | **能**。`electron desktop --no-sandbox` 开窗，加载 `http://127.0.0.1:53140/`，曲库列表渲染出 4 行 |
| origin 方案 | **选 (a) 主进程静态服务 + 固定 `http://127.0.0.1:53140`**；(b) `app://qingyin` 也实现了、也实测过，作为对照保留 |
| 端口 | **53140，常量，绝不回退**（`desktop/constants.js` 的 `PORT`）。被占用就报错退出，因为换端口 = 换 origin = 用户数据"消失" |
| origin 持久性 | **通过**。进程完全退出后重开，探针记录与 4 首曲目都还在（数据见 §3） |
| fs 桥 | 设计见 §4，**未实现**（§3.5 实测后降级为可选优化，本期不做） |
| t2 五件套 | **全部做完并自动化验证通过**（§3.6）：托盘、关窗到托盘、单实例、开机自启、版本号 |
| 开机自启的实现方式 | **自管 HKCU Run 注册表项**（`desktop/autoStart.js`），Electron 官方 `setLoginItemSettings` 在 44.9.1 静默失效——完整调查与验证桥接见 §8 |
| t5 补歌词 | **做完并自动化验证通过**（§9）：托盘/面板一键调外部工具（LyricFlow）→ 工具退出 0 → 渲染进程自动重扫认领 .lrc；顺带修了 `rescanLyrics` 快照失效这个预存 bug（web 版同受益） |
| 本机坑 | 坑 1-5 见 §5；t2 新增坑 6-10（PowerShell 自动变量、CDP 关窗陷阱、DSH 沙箱降权 Electron 子进程、僵尸进程、编辑器剥 BOM） |

---

## 1. 怎么跑起来（可复现命令）

全部在仓库根目录 `D:\轻音播放` 执行。

```powershell
# (1) 装 Electron 二进制。npm 包已经装好了，但 pnpm 12 默认跳过 postinstall，
#     所以要单独跑一次下载脚本（内部走 npmmirror，绕开被 hosts 屏蔽的 GitHub）
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
pnpm add -D electron
node desktop/installElectron.js

# (2) 构建前端（pnpm 脚本在本机可用；沙箱里如果 pnpm 起不来，用下面那行注释掉的）
pnpm build
# node node_modules/vite/bin/vite.js build

# (3) 启动桌面端（这就是验收要的那条命令）
powershell -ExecutionPolicy Bypass -File desktop/start.ps1
# 等价于手写：
#   Remove-Item Env:\ELECTRON_RUN_AS_NODE
#   node_modules\electron\dist\electron.exe desktop --no-sandbox

# (4) origin 持久性实验（两阶段：写入 → 完全退出 → 重开读取）
node desktop/runProbe.js              # 只测方案 a（http://127.0.0.1:53140）
node desktop/runProbe.js --origin=app # 只测方案 b（app://qingyin）
node desktop/runProbe.js --both       # 两个都测并对比

# (5) 用 Playwright 驱动**真入口**，断言窗口里渲染出了曲库（验收项，也是 t3 的技术路线预演）
node desktop/checkWindow.js

# (6) t2 五件套全量验证：托盘/关窗到托盘/单实例/开机自启/版本号
node desktop/checkTray.js
# 单元测试（纯函数 + 真注册表读写往返，43 个）：
npm run test:desktop          # 即 node --test "desktop/*.test.cjs"

# (7) 总验收：t3 四条硬指标 + t7 三组（补歌词成功/失败/取消、托盘播放控制、窗口状态记忆）
node desktop/verify.mjs
# 判定细节与人工清单（t3 四项 + t6 两项 + t7 三项）见 desktop/verify.md
```

`desktop/start.ps1` 支持的开关：`-Rebuild`（先构建再启动）、
`-KeepSandbox`（换机器时验证沙箱能不能开，本机不行）。

上面第 (3) 条已经实测过：窗口标题 `轻音播放`，服务只绑在回环地址上
（`Get-NetTCPConnection -LocalPort 53140 -State Listen` → `LocalAddress 127.0.0.1`），
自检接口返回 `{"ok":true,"app":"qingyin-player","token":"5f47ef3aa8dd267feaab6523","pid":26728}`。

**产物落在哪**：探针报告与截图在 `artifacts/desktop/`（已被 `.gitignore` 忽略）：
`probe-<origin>-<phase>.json/.png`、`probe-summary.json`、`window-main.png`、`run-http.log`、`run-app.log`、`verify.log`。
Chromium 的用户数据（含 IndexedDB）在 `artifacts/desktop/userdata/`——本机被迫降级到这里，原因见 §5 坑 3。

---

## 2. origin 选型：两个方案都实现了，都实测了

`file://` 一开始就排除：origin 变成 `null`，IndexedDB / Service Worker / `fetch` 全都不认，
用户数据无处可放。剩下两条路都写成了可跑的代码：

| | (a) 主进程静态服务 | (b) `app://` 自定义协议 |
| --- | --- | --- |
| 代码 | `desktop/staticServer.js`（`node:http`，只绑 127.0.0.1） | `desktop/appProtocol.js`（`protocol.handle`） |
| origin | `http://127.0.0.1:53140` | `app://qingyin` |
| `isSecureContext` | `true`（实测） | `true`（实测，靠 `registerSchemesAsPrivileged({secure:true})`） |
| IndexedDB 持久化 | **通过**（实测，§3） | **通过**（实测，§3） |
| Service Worker | **可用**：`registrations: 1`、`scopes: ["http://127.0.0.1:53140/"]`，第二次启动 `controlled: true` | **不可用**：`navigator.serviceWorker.getRegistrations()` 抛 `Failed to get ServiceWorkerRegistration objects: The document is in an invalid state.` |
| Range / 206（拖动进度条必需） | **白拿**：真实 HTTP 服务，`parseRange` + `fs.createReadStream(target,{start,end})` 已实现 | **要自己实现**：`protocol.handle` 返回的 `Response` 不带 Range 语义，当前实现整文件读进内存再包 `Uint8Array`，音频 seek 会退化 |
| 端口冲突风险 | 有（固定端口可能被占）→ 已按"报错退出、绝不换端口"处理 | 无 |
| 网络面 | 有，但只监听 `127.0.0.1`，且校验 `Host` 头（防 DNS rebinding）、只服务 `dist/`、拒绝路径穿越、非 GET/HEAD 返回 405 | 无 |
| 与现有冒烟测试的一致性 | **同构**：`scripts/check-ui.mjs` 本来就是起一个 127.0.0.1 静态服务加载 `dist/`，MIME 表都对齐了 | 另一套心智模型 |

### 选 (a) 的理由（一句话版）

**桌面端播放迟早要走 `url` 而不是 `blob`（`store.ts` 里取文件的 `getFile()` 是同步的，而 fs 读取天生异步），
真实 HTTP 服务天然给出标准 Range/206，`app://` 得自己造一遍——而且实测 `app://` 上 Service Worker 直接不可用，
等于又多一处与浏览器版的行为差异。**

补充说明（都基于上面的实测数据，不是拍脑袋）：

- `TrackSource` 已经是 `{ blob?, url? }`，`audioEngine.load()` 两条路都支持，所以走 `url` 不用动 core/ui 的类型。
- 选 (a) 之后，桌面端加载的页面与 `pnpm build` 出来的浏览器产物**同一个 origin 语义**：
  `fetch`、CORS、安全上下文、SW 注册行为全部与已验证的浏览器路径一致，回归风险最小。
- SW 在桌面端**可用但不想要**（升级后会拿到旧外壳）。这是实现阶段要处理的一件事：
  要么让静态服务对 `/sw.js` 返回 404，要么启动时 `session.clearStorageData({ storages: ['serviceworkers'] })`。
  本阶段先不动，只把实测行为记下来（第一次启动 `controlled:false`，第二次 `controlled:true`——确实会接管）。

### 端口规则（写死在代码里）

`PORT = 53140` 是 `desktop/constants.js` 里的常量。`staticServer.listen()` 遇到 `EADDRINUSE`
**直接 reject**，`main.js` 弹框告诉用户"53140 被占了，用 `netstat -ano | findstr :53140` 看看是谁"然后退出，
**绝不自动换端口**——换了端口就是换了 origin，IndexedDB 分区跟着变，用户会觉得"曲库全没了"。
另外 `main.js` 里已经有 `app.requestSingleInstanceLock()`，第二个实例只会把第一个窗口拉到前台，
不会来抢端口。

---

## 3. origin 持久性实验：读数原文

方法：`node desktop/runProbe.js` 跑两阶段，每阶段是**一个独立的 electron 进程**，
阶段之间进程完全退出（`app.quit()` 干净关闭，让 IndexedDB 落盘；驱动还额外等 2 秒并确认端口已释放）。

探针库故意用**另一个数据库** `qingyin-desktop-probe`（v1，store `probe`，key `origin`），
不去碰应用的 `qingyin-player`（v2）——用空 upgrade 打开一个 v2 库会造出一个没有 store 的坏库，反而毁了应用数据。

### 方案 a：`http://127.0.0.1:53140`（最终选型）

写入阶段（第 1 个进程）：

```
url            http://127.0.0.1:53140/?selftest=1
origin         http://127.0.0.1:53140
secureContext  true
app            qingyin-player v0.1.0（electron 44.9.1 / chrome 152.0.7977.167 / node 24.22.0）
userData       D:\轻音播放\artifacts\desktop\userdata（备用目录；原本要用 C:\Users\Admin（无密码）\AppData\Roaming\qingyin-player）
selfTest       fail 内置自检 — 存在失败项        ← 唯一失败项见下面注
探针库 qingyin-desktop-probe/origin
  打开前读到  null（库里没有记录）
  本次写入    probe-write-1792599225539 @ undefined
  操作后读到  probe-write-1792599225539 @ 2026-10-21T16:13:46.221Z（记录数 1）
应用数据 曲目 4 首，列表 4 行：青花瓷、青花瓷、fake APE标签读取失败、plain
  扫描 done parsed=4 reused=0
userData/IndexedDB：http_127.0.0.1_53140.indexeddb.blob(554B)、http_127.0.0.1_53140.indexeddb.leveldb(14928B)
databases      [{"name":"qingyin-player","version":2}]
storage.persisted true
serviceWorker  {"supported":true,"registrations":1,"controlled":false,"scopes":["http://127.0.0.1:53140/"]}
showDirectoryPicker function
contextBridge 二进制 {"ctor":"Uint8Array","isUint8Array":true,"length":4096,"byteLength":4096,"head":[3,10,17,24],"tail":[245,252]}
控制台报错 0 条
```

重开阶段（第 2 个进程，完全退出之后）：

```
url            http://127.0.0.1:53140/?selftest=1
origin         http://127.0.0.1:53140
探针库 qingyin-desktop-probe/origin
  打开前读到  probe-write-1792599225539 @ 2026-10-21T16:13:46.221Z   ← 跨进程活下来了
  操作后读到  probe-write-1792599225539 @ 2026-10-21T16:13:46.221Z（记录数 1）
应用数据 曲目 4 首，列表 4 行：fake APE标签读取失败、plain、青花瓷、青花瓷
  扫描 idle parsed=0 reused=0                                        ← 没有重扫，纯从 IndexedDB 恢复
userData/IndexedDB：http_127.0.0.1_53140.indexeddb.blob(554B)、http_127.0.0.1_53140.indexeddb.leveldb(15297B)
databases      [{"name":"qingyin-desktop-probe","version":1},{"name":"qingyin-player","version":2}]
storage.persisted true
serviceWorker  {"supported":true,"registrations":1,"controlled":true,"scopes":["http://127.0.0.1:53140/"]}
```

> 注（如实报告）：写入阶段的内置自检 38 项里只有 **1 项不通过**：
> `虚拟化：500 首只渲染视口内的行` actual=`false` expected=`true`；其余全部通过。
> 同一份 `dist/` 在 http/read、app/write、app/read 三次运行里**全部 pass**，
> 所以这是"窗口刚建好、布局还没完成时跑 500 首虚拟化断言"的首帧偶发，与 origin 选型无关。
> 截图 `artifacts/desktop/probe-http-write.png` / `probe-http-read.png` 留给人工过目
> （跑探针的这个模型不能读图，所以用 DOM 行数与标题作为客观证据）。

**真入口复验**（`node desktop/checkWindow.js`，走 `desktop/main.js` 而不是探针分支，
用 playwright-core 的 `_electron.launch()` 驱动，读的是上面两次运行留下的同一份 IndexedDB）：

```
href: http://127.0.0.1:53140/
origin: http://127.0.0.1:53140
isSecureContext: true
title: 轻音播放
rows: 4
titles: ["fake APE标签读取失败","plain","青花瓷","青花瓷"]
emptyState: false
hasTestHooks: false          ← 正式入口不挂 __qingyinTest，只有 ?selftest=1 才装
hasDesktopBridge: true       ← preload 的 window.qingyinDesktop 到位
databases: ["qingyin-desktop-probe@v1","qingyin-player@v2"]
✓ 曲库列表渲染出 4 行
```

这条比探针更有说服力：**写数据的是探针进程，读数据并渲染成列表的是正式壳进程**，两边只是恰好同一个 origin。

### 方案 b：`app://qingyin`（对照）

```
---- app / write ----   退出码 0
url            app://qingyin/index.html?selftest=1
origin         app://qingyin
secureContext  true
selfTest       pass 内置自检 — 全部通过
  打开前读到  null（库里没有记录）
  本次写入    probe-write-1792599261513 @ undefined
  操作后读到  probe-write-1792599261513 @ 2026-10-21T16:14:22.110Z（记录数 1）
应用数据 曲目 4 首，列表 4 行；扫描 done parsed=4 reused=0
userData/IndexedDB：app_qingyin_0.indexeddb.blob(554B)、app_qingyin_0.indexeddb.leveldb(14878B)
serviceWorker  {"supported":true,"registrations":"ERR Failed to get ServiceWorkerRegistration objects: The document is in an invalid state.","controlled":null}

---- app / read ----    退出码 0（进程已完全退出后重开）
  打开前读到  probe-write-1792599261513 @ 2026-10-21T16:14:22.110Z   ← 也活下来了
  操作后读到  probe-write-1792599261513 @ 2026-10-21T16:14:22.110Z（记录数 1）
应用数据 曲目 4 首，列表 4 行；扫描 idle parsed=0 reused=0
userData/IndexedDB：app_qingyin_0.indexeddb.leveldb(15233B)
```

结论：**两个方案的 IndexedDB 都跨进程存活**（物理证据是各自 leveldb 目录的字节数在第二次运行时变化），
差别在 Service Worker（b 不可用）与 Range/206（b 要自己造）。所以选型理由不是"b 存不下数据"，
而是 §2 里那条播放路径的差异。

### 其它实测事实（实现阶段会用到）

- `navigator.storage.persist()` → `true`；`storage.estimate()` → `usage 628978 / quota 203954178290`（≈190 GB）。
- `typeof window.showDirectoryPicker` → **`"function"`**：Electron 44 里 File System Access API 是存在的。
  **能不能真弹窗已经实测：能，见下面 §3.5**——结论是桌面端不需要 fs 桥也能用。
- `contextBridge` 传二进制**没问题**：主进程返回的 `Uint8Array` 到渲染进程仍是
  `Uint8Array`（`isUint8Array:true`、`byteLength:4096`、内容 `(i*7+3)&0xff` 校验通过）。
  这条直接决定 fs 桥可以用 IPC 传字节，不需要 base64。
- `navigator.userAgent` 里带上了我们的名字与版本：
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) qingyin-player/0.1.0 Chrome/152.0.7977.167 Electron/44.9.1 Safari/537.36`。
- 控制台只有 Electron 自己那条开发期安全警告（`Insecure Content-Security-Policy`，打包后消失）。
  **`dist/index.html` 没有 CSP** —— 实现阶段可以从我们的静态服务下发一条 `Content-Security-Policy` 响应头
  （比 meta 标签强，而且我们正好控制着服务端），顺手把这条警告消掉。
- 环境：Windows 10 家庭中文版 19045 x64；Electron 44.9.1 / Chrome 152.0.7977.167 / Node 24.22.0 / V8 15.2.124.43-electron.0。

### 3.5 showDirectoryPicker 实测（实现阶段开工前的插播实验，2026-10-22）

**结论：可用。** 真实点击应用自己的「选择音乐文件夹」按钮后，Windows 原生目录选择框
（`#32770`，标题「选择允许此网站查看的文件夹」）真的弹出来；选中
`D:\轻音播放\新建文件夹` 后 `showDirectoryPicker()` 返回真实句柄，曲库完整扫进来：
**曲目 22 首、`.lrc` 16 个、已认领歌词 16 首**（与该目录的实际内容一致）。
用户取消时抛 `AbortError`（原文：
`Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.`），
`store.ts` 的 `pickDirectory` 会捕获并转成 info 级通知——取消不算错误，路径健壮。

**架构含义：fs 桥（§4）从"唯一出路"降级为"可选优化"**（原生 Range/206 播放、
跳过每次重启后的重新授权提示这类体验升级）。本期明确不做桥。

复现命令（全自动化，不需要真人点对话框）：

```
node desktop/checkDirectoryPicker.js
```

它做的事：Playwright 真实点击按钮（CDP 输入带用户激活，不是 evaluate 凭空调用）→
`desktop/driveFolderDialog.ps1` 用 UI Automation + Win32 消息驱动原生对话框 →
断言探针、扫描统计、曲目数、歌词认领数，截图与 JSON 报告落
`artifacts/desktop/directory-picker.*`。

驱动这个原生对话框踩出来的坑（换机器写自动化会再遇到，全部记下来）：

1. **UI Automation 的 RootElement.Children 枚举看不到这个对话框**——它是 owned
   window。必须用 user32 `EnumWindows` 找（`snapshotDesktop.ps1` 里就是这个方法）。
2. **对话框属于一个 electron 工具进程**——既不是拥有主窗口的浏览器进程，也不是
   Playwright 报的 pid（那是它自己起的包装进程）。按 pid / 命令行过滤全都匹配不上；
   实践中按「窗口类 #32770 + 进程名 electron」匹配即可。
3. **这个经典 Win32 通用对话框的 UIA ControlType 全部谎报成 Pane**（编辑框、按钮
   都是），按 `ControlType.Edit` / `ControlType.Button` 找不到；`ValuePattern` /
   `InvokePattern` 也拿不到。可靠的做法是纯 Win32：`EnumChildWindows` 按
   ClassName + 控件 ID 找 HWND（路径框 `Edit`/1152、确认键 `Button`/1=IDOK、
   取消键 `Button`/2），然后 `WM_SETTEXT` 填路径、`BM_CLICK` 点确认。
4. `WM_SETTEXT` **不会触发 EN_CHANGE**——对话框靠这个通知启用 OK 按钮，所以要补发
   一条 `WM_COMMAND(EN_CHANGE)`；不补的话按钮可能是灰的（本次实测补发后
   `OK-ENABLED True`）。
5. 两个容易误判的读数：路径框 `GetWindowText` 读回是**空串**（但 IDOK 仍按内容
   处理，读回为空不代表失败）；`Alt+D` 键盘导航会把路径敲到别处（还会弹出别的子
   对话框），不要用。
6. 运行注意：这个实验会把目标目录真的扫进 IndexedDB（曲库状态会变），驱动对话框
   时会短暂抢占鼠标与前台焦点（对话框需要真实置前）。

### 3.6 t2 壳层五件套：实现与验证（2026-10-22）

五个能力全部落在主进程侧，渲染进程一行没动（`?selftest=1` 的 `window.__qingyinTest`
测试钩子继续可用，见下）：

| 能力 | 实现 | 验证点 |
| --- | --- | --- |
| 托盘 | `desktop/tray.js`（图标取 `dist/icons/icon-192.png`，192→32 缩放；左键点图标=切换窗口，双击=总是显示）+ `desktop/trayMenu.js`（纯数据模板：显示/隐藏窗口、开机自启勾选、检查更新（禁用预留）、退出） | 托盘创建、菜单结构、tooltip `轻音播放 v0.1.0` |
| 关窗到托盘 | `main.js` 的 `close` 事件 `preventDefault` + `hide()`；`quitApp()`（托盘退出）才真正退出 | 投递真实 WM_CLOSE 后：窗口隐藏不销毁、进程存活、静态服务响应、**音乐继续放** |
| 单实例 | `app.requestSingleInstanceLock()`（锁的 key = userData 路径，所以二启必须传同一个 `--user-data-dir`） | 第二/第三个实例 exit 0、原窗口被唤回且只有 1 个窗口 |
| 开机自启 | `desktop/autoStart.js` 自管 HKCU Run + StartupApproved（官方 API 失效，见 §8）+ `desktop/shellSettings.js`（`userData/settings.json` 是开关状态的真源） | settings.json 写入读回、菜单勾选、注册表写入读回（node 桥，§8） |
| 版本号 | `desktop/appVersion.js` 读根 `package.json` 的 version（必须目录方式启动，见 `entry.js` 注释）→ `desktop/shellText.js` 把 ` v0.1.0` 拼进托盘 tooltip 与原生窗口标题（`page-title-updated` 拦截 + `setTitle`，页面标题不被污染） | 原生标题 `轻音播放 v0.1.0`、托盘 tooltip、菜单「当前 v0.1.0」 |

**验证脚本 `node desktop/checkTray.js`**（Playwright 驱动真入口；全量判定与证据
JSON 在 `artifacts/desktop/tray-check.json`，截图在 `artifacts/desktop/tray-*.png`）：

1. **托盘与版本号**：`readState().trayCreated`、版本号来源、原生窗口标题带版本
   （`BrowserWindow.getTitle()`）、页面标题无版本号污染、托盘菜单四项结构与文案。
2. **显示/隐藏切换**：托盘 API 隐藏→窗口不可见但对象在→菜单文案翻转为「显示窗口」→
   再显示→文案翻回「隐藏窗口」。
3. **关窗到托盘（音乐不能停）**：先切到列表循环（内置样本只有 2 秒/首，队列模式
   8 秒就放完停下，会把"仍在播放"误判成失败）→ 双击列表第一行真实播放 →
   `desktop/postCloseToQingyin.ps1` 用 EnumWindows 找到轻音主窗口、投递 **WM_CLOSE**
   （真实 X 按钮路径；CDP 的 `window.close()` 是绕过 close 事件陷阱的假路径，见坑 7）→
   断言：窗口不可见、窗口对象还在（被拦截成 hide）、不触发退出流程、桌面顶层窗口
   清单里没有轻音、进程存活、静态服务仍响应、主进程 `win.close()` 同样被拦截 →
   等 5 秒 → 仍在播放且进度在走 → 全程渲染进程零报错。
4. **二次启动（单实例）**：spawn 第二个实例（带同一个 `--user-data-dir`）→ exit 0、
   原窗口被唤到前台、`BrowserWindow.getAllWindows()` 只有 1 个、原实例存活；
   再在隐藏状态下三启 → 窗口被唤回。
5. **开机自启（写 + 读回）**：见 §8 的完整说明（app 侧 settings.json + 菜单勾选 +
   注册表写入读回走 node 桥 + 独立 reg query 复核 + 复位清理，不给这台机器留 Run 项）。
6. **托盘退出**：`quit()` → 进程 exit 0 → 53140 端口释放（服务已关）。

给自动化用的主进程句柄：`globalThis.__qingyinDesktopShell`（`readState` / `showMainWindow` /
`hideMainWindow` / `toggleMainWindow` / `quit` / `setOpenAtLogin` / `readOsOpenAtLogin`）。
只挂在主进程（sandbox + contextIsolation 下渲染进程够不到），托盘菜单项点击调用的
就是这同一批函数——**自动化路径与真实用户路径走同一份代码**，t3 复验直接用它。

人工复验清单（自动化之外，30 秒能过完）：

- [ ] `powershell -ExecutionPolicy Bypass -File desktop/start.ps1` 启动；
- [ ] 点一曲播放，点窗口 X：窗口消失、音乐不停；
- [ ] 任务栏右下角托盘图标（左键=显隐切换，右键=菜单）；标题栏/托盘悬浮显示版本号；
- [ ] 再开一个同样的启动命令：不弹第二个窗口，原窗口被唤到前台；
- [ ] 托盘菜单勾「开机自启」，到任务管理器→启动应用里看「qingyin-player」变为"已启用"
      （或 `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v qingyin-player`）；
      取消勾选后该项消失；
- [ ] 托盘菜单「退出」：托盘图标消失、进程退出。

### 3.7 t3 验收：Playwright 驱动桌面端 + 人工清单（2026-10-22；t7 已扩展）

> **t7 扩展（2026-10-22）**：同一个 `verify.mjs` 现在共 **123 条断言**（沿用 t3 37 条 +
> 本期新增 86 条），多进程覆盖三组新能力，耗时约 45 秒：
> 补歌词（假工具 running→done→自动认领/UI 通知；不存在路径与工具 exit 5 两条失败路径；
> 慢工具取消 + 进程树 0 残留）、托盘播放控制（隐藏态 play-pause/next/prev，主进程与
> 渲染进程下标一致）、窗口状态记忆（记住/重启恢复/最大化/屏幕外 x=3000 与 x=99999 回退）。
> 判定细节见 [`desktop/verify.md`](verify.md) 第 2.6–2.9 节；人工清单见第 6 节。
> 报告 `verify.json` 的 `assertionSummary` 与 `assertions.inherited/added` 就是分组账。

脚本 `node desktop/verify.mjs`（每次用独立 profile `artifacts/desktop/userdata-verify*`，
启动前清空，不碰真实曲库）。报告 `artifacts/desktop/verify.json`，截图
`verify-library.png` / `verify-lyrics.png` / `verify-after-hide.png` / `verify-desktop-hidden.png` /
`verify-lyrics-fill.png`。
**完整判定细节与人工清单在 [`desktop/verify.md`](verify.md)**，这里只记结论与坑。

| 验收条 | 判据（全部打印实测值） | 本次读数 |
| --- | --- | --- |
| 窗口 + 列表 | `waitForSelector('.row, .empty')` → 等 `rows>=4` → 再让两帧 → 才数 | 4 行：青花瓷 / 青花瓷 / fake APE / plain |
| 真实播放 | 双击 plain 行；`audio.paused=false`、`currentTime>0.05`、`src` 是 blob URL | `plain.mp3`，src `blob:http://127.0.0.1:53140/…` |
| 歌词面板 | 点侧栏「歌词」；断言不是占位态、3 行文本、标题=当前曲目 | 第一句/第二句/第三句 |
| **隐藏后继续播** | `hideMainWindow()`（托盘菜单同一函数）→ 3 秒内每 150ms 采样 → 累计正增量 ≥1s 或自动切歌 | 21 次采样 / 3.1s：0 次暂停，累计前进 **2.956s**，切歌 1 次；EnumWindows 可见窗口里无轻音 |
| 反证（防空转） | 暂停后用同一套采样，必须量不到前进 | `0.329108 → 0.329108`（delta 0） |

这段验证踩到的两个事实，别再当成 bug 追：

1. **`BrowserWindow.hide()` 不改变 `document.visibilityState`**（21 次采样全 `visible`）。
   页面可见性不能当"窗口已隐藏"的判据；用主进程 `isVisible()` + OS 层 EnumWindows。
2. `?selftest=1` 的自检结果浮层 `#selfTestResult` 会拦截鼠标事件（实测盖住抽屉关闭按钮）。
   脚本量完结论后把它从 DOM 摘掉；真实用户入口没有这个节点。自检本身会临时塞 500 首
   合成曲目，必须等 `<html data-self-test>` 出现后再量行数（虚拟化偶发的根因）。

人工四项（托盘图标与菜单 / **重启后**自启 / 隐藏时的系统媒体键 / 托盘退出）见 `verify.md` 第 3 节，
每项都写了"怎么看、预期、不符合时记什么"——其中重启自启与系统媒体键无法自动化。

### 3.8 t6：托盘播放控制 + 窗口状态记忆（2026-10-22）

两件事都只在 `desktop/` 里落地，渲染侧只加了一个独立文件（`src/ui/desktopShell.ts`）
和 `src/main.tsx` 里的两行——**没有动 `store.ts`**，没有新增依赖。

#### 3.8.1 托盘播放控制：两条单向通道，主进程一律不猜

```
托盘菜单点「暂停」
  → main.js sendPlaybackCommand('play-pause')         （白名单：constants.SHELL_COMMAND_TYPES）
  → webContents.send('shell:command', { type })       （窗口隐藏时照样送达）
  → preload.js onCommand 的 listener
  → src/ui/desktopShell.ts 按 type 只调 store 既有动作 togglePlay / previous / next

渲染侧状态变化
  → useAppStore.subscribe → 只在 {playing,currentIndex,queueLength,hasTrack} 这组切片变了才发
  → preload.js reportStatus（只过桥这四个键）
  → mainIpc.js ipcMain.on('shell:status')
  → playbackStatus.js normalizePlaybackStatus → main.js 存下 → tray.refresh()
```

两个刻意的设计决定：

1. **播放状态一律由渲染进程上报，主进程不推断。** 自动切歌、整队放完停下、用户按媒体键，
   这些时刻只有 store 知道；猜出来的「播放/暂停」文案一定会在某个时刻骗用户。
   上报是**节流**的（只在菜单关心的四个字段变化时发），音量/静音/抽屉开关这些都不会触发。
2. **没有当前曲目时三项直接禁用**（`hasTrack = queue.length > 0 && currentIndex >= 0`）。
   一个点了没反应的菜单项比一个灰掉的更糟。曲库为空时实测：三项都在、都 `enabled:false`、
   文案是「播放」。

窗口隐藏（未销毁）时命令必须生效——这就是本功能的全部意义，所以验收脚本第 4 步
**全程在隐藏状态下**发命令，并顺手断言 `windowVisible === false`。

#### 3.8.2 窗口状态记忆：存在 settings.json，不进 IndexedDB

存在 `desktop/shellSettings.js` 的第四个键 `windowState`（`{x,y,width,height,maximized}`）。
**刻意不进 IndexedDB**：这是壳层状态，必须在渲染进程存在之前就能同步读到（开窗那一刻就要用），
而 IndexedDB 只有页面加载后才可访问，且和曲库数据混在一起会让"清曲库"顺带清掉窗口位置。

三个必须处理的真实情况：

| 情况 | 处理 | 代码 |
| --- | --- | --- |
| **拔掉副屏后坐标落在不存在的屏幕上**（窗口"打开了但看不见"） | 启动前用 `screen.getAllDisplays()` 的 workArea 做双轴重叠校验，不足 120px 视为越界 → 回退主屏居中默认尺寸，并把原因打进日志 | `windowState.js resolveStartupWindow` |
| **最小化时 `getBounds()` 返回 -32000** | 最小化直接返回 null（不排写盘）；最大化时取 `getNormalBounds()`，存的是还原后的真实尺寸 | `windowState.js captureWindowState` |
| **拖动时每次像素变动都触发 resize/move** | 600ms 防抖 + 与上次写盘内容去重；真退出（托盘「退出」/会话结束）时 flush 一次 | `windowState.js createDebouncedSaver` |

`saveSettings` 是**部分更新**语义（t5 定的），所以几何写盘只传 `{ windowState }`，
开机自启开关和补歌词的两个路径不会被冲掉——`shellSettings.test.cjs` 里两个方向都钉了断言。

#### 3.8.3 实测（两个脚本，全部打印真实读数）

`node desktop/checkTrayPlayback.js` → `artifacts/desktop/tray-playback-check.json`：

| 验收条 | 判据 | 本次读数 |
| --- | --- | --- |
| 空曲库 | 三项存在且禁用、文案「播放」 | ids `[…play-pause,prev,next…]`；三项 `enabled:false`；`hasTrack:false` |
| 播放后文案 | 上报 → 菜单换向 | `{playing:true,hasTrack:true,currentIndex:0,queueLength:4}`，文案「暂停」，三项 `enabled:true` |
| 隐藏期间还在放 | 密集采样（样本只有 1–2 秒，隔 1.2 秒比一次会被循环重播骗到） | 8 次采样 `0.841→1.881→0.048→0.248`，`paused` 全 false |
| **隐藏时「暂停」** | `audio.paused === true` | `paused:true`，文案换回「播放」，主进程 `playing:false`，`windowVisible:false` |
| **隐藏时「播放」** | `audio.paused === false` | `paused:false`，文案「暂停」 |
| **隐藏时「下一首」** | 下标前进且与渲染侧一致 | `0 → 1`；主进程记的 `currentIndex:1` === 渲染进程 store 的 `1` |
| 隐藏时「上一首」 | 下标回退到切歌前那首 | `1 → 0`（=== `indexBeforeNext`） |
| 白名单 | 非播放命令不许发出去 | `playbackCommand('quit')` → `{ok:false,reason:'不是合法的播放命令：quit'}` |

`node desktop/checkWindowState.js` → `artifacts/desktop/window-state-check.json`，**连开四次真实进程**
（每次都读磁盘上的 `settings.json`，不问主进程"你以为存了什么"）：

| 启动 | 做了什么 | 本次读数 |
| --- | --- | --- |
| 1（首次，无存档） | 默认几何 → `setBounds` → 12 次像素级移动 → 最大化 → 托盘退出 | 来源 `default`，`{48,0,1440,824}`；落盘 `{60,40,1180,704}`；**写盘计数 1 → 1**（防抖生效）；最大化后存 `{72,52,1198,722,maximized:true}`，而屏幕 bounds 是 `{-7,-7,1552,840}`（证明存的是 normalBounds） |
| 2（有存档） | 恢复 → 还原 → 换几何 → 退出 | 来源 `saved`，`isMaximized()===true`；还原后 `{72,52,1200,727}` ≈ 存档的普通几何；新几何 `{220,160,1024,600}` 落盘 |
| 3（存档 `-32000,-32000`） | 必须回退到屏幕内 | 来源 `default`，reason「已保存的位置 …不在任何屏幕的工作区里（显示器被拔掉？），回退到主屏居中」；窗口可见且 `{48,0,1440,824}` 通过 workArea 重叠校验；退出时写回的是屏幕内几何 |
| 4（存档 `x=3000`，模拟拔掉的副屏） | 回退 + 隐藏后退出 | 来源 `default`，窗口在屏幕内；隐藏（未销毁）后走托盘退出 → 存档里没有 `-32000` 类垃圾坐标 |

单测：`playbackStatus.test.cjs` 12 / `windowState.test.cjs` 32 / `channels.test.cjs` 8 /
`shellSettings.test.cjs` 20（含 6 个 windowState）/ `src/ui/desktopShell.test.ts` 15。
`channels.test.cjs` 是个**静态防漂移**测试：把三份源码当文本读，钉住通道名字面量、命令白名单、
上报字段名在 `constants.js` / `preload.js` / `main.js` / `mainIpc.js` / `src/ui/desktopShell.ts`
之间一致（sandbox 化的 preload 不能 `require` 本地模块，通道名只能重复写，所以必须有这道锁）。

#### 3.8.4 渲染侧那 20 行的三条硬约束（队长定的，单测逐条钉住）

`src/ui/desktopShell.ts` 是这次唯一进 `src/` 的新文件，`src/ui/desktopShell.test.ts` 15 个用例：

1. **零影响**：桥不存在（浏览器 / PWA）→ 在订阅任何东西**之前**就 return，不碰 store、
   不注册全局监听、不上报（4 个用例，含"桥只有半个"和"桥是垃圾值"）。
2. **只调既有动作**：三条命令分别只调 `togglePlay` / `previous` / `next`（用 spy 替掉，
   不碰真实 audio），未知 type 忽略；`channels.test.cjs` 另外静态禁止这个文件里出现
   `getAudioElement` 或 `useAppStore.setState`。
3. **幂等**：`startDesktopShell()` 连调三次只订阅一次（HMR 会重跑入口）；
   上报回调整个换成会抛的，也不许打断订阅。
4. 动作 reject / 抛错都不许冒泡成渲染进程的 unhandled rejection（`runStoreAction` 兜住），
   且之后的命令照常可用。

web 侧无退化的客观证据：`pnpm verify` 全绿（`tsc --noEmit`、vitest 452 passed | 1 skipped、
`node --test "desktop/*.test.cjs"` 117 passed、demo 37 passed、`check:static`、
`check:bundle` 产物检查通过，exit 0），`vite build` 的 precache 从 577.54 KiB 变 577.82 KiB。

人工两项（托盘三键的手感、拖动/最大化后重启看窗口回位）见 `verify.md` 第 5 节。

---

## 4. fs 桥最小设计（**只有设计，没有实现**）

### 4.1 现状与目标

现在浏览器版靠 `showDirectoryPicker()` 拿到 `FileSystemDirectoryHandle`，
经 `browserMusicSource` 适配成 `MusicSource`，再喂给 `scanLibrary`。桌面端要换掉"取文件"的那一层，
但**不能动 core/ui/platform 的既有代码**（本阶段边界），所以设计目标是：

> 新增一个 `MusicSource` 实现，让 `scanLibrary` 原封不动地复用——包括 `.lrc` 单独收集那条路。

`scanLibrary(options)` 的入参是 `{ storage, source: MusicSource, onProgress, signal, batchSize }`，
`source` 只要求满足 `MusicSource` 接口，所以插一个新实现即可，`scanner.ts` 一行都不用改。

### 4.2 主进程：fs 能力（IPC 通道表）

主进程**不做任何策略判断**（不判断扩展名、不猜编码），只做"受限的文件系统访问"，
策略全部留在渲染进程复用 core 的既有判定，这样"什么算音频/什么算歌词"永远只有一份实现。

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `fs:pick-folder` | 无（可选 `defaultPath`） | `{ root, rootName } \| null` | `dialog.showOpenDialog({ properties: ['openDirectory'] })`；用户取消返回 `null`。返回前把 `root` 记进主进程的"已授权根目录"白名单 |
| `fs:list-folder` | `{ root, requestId }` | `{ audio: FsEntry[], lyric: FsEntry[] }` | 一次遍历**同时**收音频与歌词（对应 `nodeMusicSource` 里那张 `lyricFiles` Map）；`FsEntry = { path, name, size, mtimeMs }`，`path` 是相对根目录的 posix 路径 |
| `fs:list-progress` | —— | `{ requestId, found }` | 主进程 → 渲染进程单向推送（`webContents.send`），驱动扫描进度条 |
| `fs:read-range` | `{ root, path, start, end }` | `Uint8Array` | 给 `ByteSource.read` 用，**保住"只读文件头"这个 M0 结论**，不要把整首歌读进内存 |
| `fs:read-whole` | `{ root, path }` | `Uint8Array` | 给 `.lrc` 用：`openLyricBytes` 要的是**原始字节**，编码判断交给 `core/lyrics.ts` 的 `decodeLyrics`，主进程绝不能先 decode 成字符串 |

安全规则（每一条都是硬要求）：

1. **只接受相对路径**：渲染进程传来的 `path` 一律 `path.resolve(root, rel)` 之后用 `isInside(root, target)`
   校验（`desktop/httpUtils.js` 里已经有这个函数，直接复用），挡 `..`、绝对路径、盘符跳转。
2. **白名单**：`root` 必须是 `fs:pick-folder` 授权过的目录之一，主进程内存里维护这张表；
   渲染进程不能凭空指定一个 `root`。
3. **遍历不跟符号链接/junction**：`entry.isSymbolicLink()` 直接跳过，避免指回系统目录被当成曲库扫。
4. 只读：整个桥**没有任何写/删通道**。

### 4.3 preload：暴露面（`contextBridge`）

`desktop/preload.js` 现在只有 `info` / `echoBytes` 两个探针方法（末尾注释已经写了目标形状）。
实现阶段把 `fs` 与 `media` 补上，**只暴露这些，不要暴露 `ipcRenderer` 本体**：

```js
contextBridge.exposeInMainWorld('qingyinDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  fs: {
    pickFolder: () => ipcRenderer.invoke('fs:pick-folder'),
    listFolder: (root, requestId) => ipcRenderer.invoke('fs:list-folder', { root, requestId }),
    onListProgress: (cb) => {                     // 返回取消订阅函数，避免泄漏
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('fs:list-progress', listener);
      return () => ipcRenderer.removeListener('fs:list-progress', listener);
    },
    readRange: (root, path, start, end) => ipcRenderer.invoke('fs:read-range', { root, path, start, end }),
    readWhole: (root, path) => ipcRenderer.invoke('fs:read-whole', { root, path }),
  },
  media: {
    url: (path) => `${ORIGIN}/media/${encodeURI(path)}`,   // 走同一个回环服务的 Range 通道
  },
});
```

`window.qingyinDesktop` 的存在性已经在真入口里验过（`checkWindow.js` 的 `hasDesktopBridge: true`），
`Uint8Array` 过桥也没问题（§3），所以这套形状不需要 base64、也不需要 `Buffer` polyfill。

### 4.4 渲染进程：`desktopMusicSource`（新增文件，不改旧的）

```ts
// src/platform/desktopMusicSource.ts（实现阶段新增）
export function desktopMusicSource(bridge: Window['qingyinDesktop'], root: string, rootName: string): MusicSource {
  const lyricRefs: LyricFileRef[] = [];            // 与 nodeMusicSource 的 lyricFiles Map 同构

  return {
    rootName,
    async listAudioFiles(onProgress) {
      const requestId = crypto.randomUUID();
      const off = bridge.fs.onListProgress((p) => { if (p.requestId === requestId) onProgress?.(p.found); });
      try {
        const { audio, lyric } = await bridge.fs.listFolder(root, requestId);
        lyricRefs.length = 0;
        for (const e of lyric) lyricRefs.push({ path: e.path, name: e.name, size: e.size, lastModified: Math.floor(e.mtimeMs) });
        return audio.map((e) => ({ path: e.path, name: e.name, size: e.size, lastModified: Math.floor(e.mtimeMs) }));
      } finally { off(); }
    },
    async open(ref) {                              // ByteSource：只读需要的区间
      return {
        name: ref.name,
        size: ref.size,
        read: (start, end) => bridge.fs.readRange(root, ref.path, start, end),
      };
    },
    // 这两个方法**必须实现**：扫描逻辑靠"某个 .lrc 不再出现"判断用户删了歌词。
    // 反过来说，如果哪天不支持歌词，就必须把这两个方法整个去掉，而不是 return []。
    async listLyricFiles() { return lyricRefs; },
    openLyricBytes: (ref) => bridge.fs.readWhole(root, ref.path),
  };
}
```

关键点：

- `listAudioFiles` 返回的 `AudioFileRef.path` 是**相对根目录的 posix 路径**，
  正好是 `scanLibrary` 缓存键（`path + size + mtime`）的一部分 → 增量扫描、过期清理、孤儿清理全部原样生效。
- `open()` 返回的对象就是 `ByteSource`，`readMetadata` 只读文件头，行为与 `nodeFileSource` 一致。
- 主进程返回 `{audio, lyric}` 两张表，是为了让渲染进程**不需要**再判断扩展名；
  如果坚持"策略只在渲染进程"，也可以让主进程返回全部条目、由渲染进程用 core 的
  `isAudioFileName` / `isLyricFileName` / `joinRelativePath` 分表——两种都行，
  但**判定函数只能用 core 里那一份**，不要在 desktop/ 里再写一遍正则。
  （推荐后者：主进程零策略，`fs:list-folder` 只返回 `{ entries }`，遍历顺序与 `nodeMusicSource.walk` 一致。）

### 4.5 唯一需要动的接缝：播放取文件的方式

`src/ui/store.ts` 里 `playbackEnv().openSource` 是**同步**的（`currentSource?.getFile(track.path)` → `{ blob }`），
而 fs 桥的读取是异步的。两条出路：

- **推荐**：`MusicSource` 上加一个**可选**方法 `mediaUrl?(path: string): string`，
  `openSource` 优先走它并返回 `{ url }`（`TrackSource` 已经是 `{ blob?, url? }`，
  `audioEngine.load()` 也支持 `url`，所以 core/ui 的类型不用改语义，只多一个可选成员）。
  `url` 指向我们自己的回环服务：`http://127.0.0.1:53140/media/<相对路径>`，
  由主进程校验白名单后以 206 流式返回 → **拖动进度条、seek、大文件都不用整首读进内存**。
- 次选：把 `openSource` 改成异步。改动面更大（调用方要跟着改），不推荐。

选 (a) 静态服务的最大好处就在这一步兑现：`/media/*` 只是静态服务上多一条路由 +
一张已授权根目录表，Range/206 全部复用 `desktop/staticServer.js` 里已经写好的 `parseRange` 逻辑。

### 4.6 选中的根目录怎么记住

不需要改 IndexedDB schema：现有 `handles` store 就是干这个的。
把 `{ kind: 'desktop-folder', root, rootName, savedAt }` 当成一个普通可序列化对象存进去，
键沿用 `MUSIC_SOURCE_ID = 'music-root'`。启动时 `boot()` 读到它就能直接重建
`desktopMusicSource` 并重扫，不必每次弹目录选择框；目录不存在（拔了移动硬盘）就退回空状态并提示重新选择。

### 4.7 实现阶段的落地顺序建议

1. ~~先试 `showDirectoryPicker()` 在壳里能不能真弹窗（§3）——能用就先不做桥，成本最低。~~
   **已试完（§3.5）：能用，曲库完整扫进来。fs 桥本期不做。**
2. ~~不能弹窗再做~~：主进程 4 个通道 → preload 暴露 → `desktopMusicSource` → `/media/*` 路由 → `openSource` 走 `url`（留给以后做播放体验升级时参考）。
3. 每步都配单元测试：桥用假 `window.qingyinDesktop` 注入，断言"只读了文件头"这条老规矩没被破坏
   （`byteSource.ts` 的注释里写明了这类测试怎么写）。

---

## 5. 本机的三个坑（实现/验证阶段一定会再踩，先写下来）

### 坑 1：`ELECTRON_RUN_AS_NODE=1`（DSH 终端会传给所有子进程）

现象：`electron.exe` 直接退化成纯 Node，`require('electron').app` 是 `undefined`，
第一行就 `TypeError: Cannot read properties of undefined (reading 'setName')`，还打印一行 `Node.js v24.22.0`。
更阴的是 `electron.exe --version` 会返回 `v24.22.0`（Node 的版本），看起来"装好了"。

处理：任何驱动脚本 spawn electron 之前先删掉它——
`desktop/runProbe.js` 的 `cleanEnv()`、`desktop/checkWindow.js` 的 `env`、`desktop/start.ps1` 的
`Remove-Item Env:\ELECTRON_RUN_AS_NODE` 都做了这件事。**Playwright 的 `_electron.launch()` 也要自己传干净的 `env`**。

### 坑 2：必须命令行传 `--no-sandbox`

现象：不带就 `0x80000003`（EXCEPTION_BREAKPOINT）秒崩，**在跑到我们任何一行 JS 之前**
（用逐步落盘的日志验证过：日志文件里一条新记录都没有）。
`--enable-logging=stderr` 能看到 `Received fatal exception EXCEPTION_BREAKPOINT`，
栈里有 `electron::fuses::IsLoadBrowserProcessSpecificV8SnapshotEnabled`。

试过没用的：`--disable-gpu`、`--disable-features=RendererCodeIntegrity`、`--in-process-gpu`、
`--disable-gpu-sandbox`、`--disable-breakpad`、`--single-process`、`--use-gl=angle --use-angle=swiftshader`，
以及**在 app 里 `app.commandLine.appendSwitch('no-sandbox')`（太晚，救不回来）**。
`whoami /groups` 显示 Medium 完整性、管理员组是 deny-only、没有 AppContainer，不是受限令牌问题。

嫌疑：本机装了 360 安全卫士（`%APPDATA%` 下有 `360Safe`），这类软件会 hook 进程/令牌相关 API，
是 Chromium 沙箱初始化失败的常见原因。**这是安全降级，必须如实记录**：
换到干净机器上要用 `desktop/start.ps1 -KeepSandbox` 或 `node desktop/runProbe.js --electron-flags=` 复测；
打包版如果也需要，只能在启动器里 re-exec 一次自己带上这个参数（`app.relaunch({ args: [...argv, '--no-sandbox'] })`），
因为 appendSwitch 无效。

排障时会遇到的一个假线索：崩掉的那些 electron.exe 会变成**杀不掉的僵尸进程**
（`Stop-Process -Force` 和 `taskkill /F /T` 都无效，命令行读不出来，CPU 恒为 0），
但它们**不占 53140 端口、不锁 userData**，重启才消失。看到 `Get-Process electron` 有一堆残留不用慌，
判断有没有真在跑要看 `Get-NetTCPConnection -LocalPort 53140 -State Listen`。

### 坑 3：electron.exe 在用户目录下建目录一律 EPERM（**这个最要命**）

现象：`fs.mkdirSync('C:\\Users\\Admin（无密码）\\AppData\\Roaming\\xxx')` → `EPERM: operation not permitted`；
`AppData\Local`、`Temp`、用户主目录全都一样；而 `D:\轻音播放\` 下随便写。
同一个账号的 PowerShell 却能建（实测 `%APPDATA%\qingyin-probe-dir` 建得出来）
→ 不是 ACL 坏了，是**未签名的 electron.exe 被安全策略拦了写用户目录**（Windows 受控文件夹访问 / 360 反勒索 一类）。

它引发的一连串"看起来毫不相干"的崩溃，全都指向同一个根因：

- `app.getPath('userData')` **直接硬崩**（进程没了，不是 JS 异常）
- `app.getLocale()` 返回**空串**
- 走到 ready 时 `EXCEPTION_ACCESS_VIOLATION (0xC0000005)`，事件查看器里
  `electron.exe / 0xc0000005 / 偏移 0x0000000007d3267b`
- 就算 `--no-sandbox` 活到页面渲染，IndexedDB 全是 `UnknownError: Internal error.`，
  `indexedDB.databases()` 也报 Internal error，磁盘缓存刷
  `Unable to move the cache: 系统找不到指定的路径 (0x3)` / `Unable to create cache`
  ——**用户数据一条都存不下来**，而 `%APPDATA%\qingyin-player` 目录压根没被创建

二分实验（`desktop/smoke2.js`，每个 case 一个进程，逐步落盘所以崩了也能看见走到哪）：

| case | 结果 |
| --- | --- |
| 直接 `getPath('userData')` | 崩 `0xFFFF7003` |
| `setName('qingyin-player')` 再 `getPath('userData')` | 崩（所以不是名字的问题） |
| **先 `setPath('userData', …)` 再 `getPath('userData')`** | **通过**，`getLocale()` 也从空串变回 `zh-CN` |
| 先 `setPath` 再等 ready | **通过**（ASCII 路径、非 ASCII 路径都通过） |
| 什么都不设，只等 ready | 崩 `0xC0000005` |
| `--user-data-dir=D:\...` 但不带 `--no-sandbox` | 仍崩 `0x80000003`（坑 2 与坑 3 相互独立） |
| `mkdirTest`：从 electron 进程里往各处建目录 | 用户目录全 EPERM，`D:\轻音播放\` 通过 |

所以 `desktop/userData.js` 定的规矩是：

1. **必须在 ready 之前** `app.setPath('userData', …)`，并且**任何时候都不要在 setPath 之前调
   `app.getPath('userData')`**；
2. 默认仍然用 `%APPDATA%/<APP_ID>`（正常机器就该跟着系统走），支持
   `--user-data-dir=` / `QINGYIN_USER_DATA` 覆盖；
3. **建目录失败就自动降级**到仓库里的 `artifacts/desktop/userdata/`（已 gitignore），
   并且在控制台大声警告——静默降级会让"我的曲库怎么没了"变成悬案。
   本机跑出来的就是降级路径，报告里 `userDataFellBack: true`、
   `userDataReason: 无法在 C:\Users\...\Roaming\qingyin-player 下创建目录…`。

顺带一条容易忽略的：`app.setName(APP_ID)` + 显式 `setPath` 还有一个正当理由——
开发时 `desktop/package.json` 的 name 是 `qingyin-player-desktop`，打包后 productName 是 `轻音播放`，
不钉死的话两者会各用各的数据目录，看起来就像"打包后数据丢了"。

### 坑 4（次要）：pnpm 12 不跑 postinstall，Electron 二进制不会自动下载

`pnpm add -D electron` 之后 `node_modules/electron/dist/electron.exe` 不存在。
原因：pnpm 12 已经**不再读 `package.json` 里的 `"pnpm"` 字段**
（警告原文：`The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.onlyBuiltDependencies"`），
配置搬到了 `pnpm-workspace.yaml`（本仓库没有这个文件）。

处理：`node desktop/installElectron.js`——它检查 `node_modules/electron/path.txt`，
缺就用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 跑 `node_modules/electron/install.js`。
（github.com / objects.githubusercontent.com 在本机被 hosts 指到 127.0.0.1，官方源下不动；
镜像可达性已验证：`v44.9.1/electron-v44.9.1-win32-x64.zip` HTTP 200、158,389,896 字节，
npmmirror / registry.npmmirror / huaweicloud 三个源大小完全一致，所以包是完整的，
不是"镜像缺文件"——顺带排除了一个错误怀疑方向：44.x 的 zip 里本来就没有
`libEGL.dll` / `libGLESv2.dll`。）

### 坑 5（次要）：`.ps1` 必须存成 UTF-8 **带 BOM**

现象：`desktop/start.ps1` 用 `powershell.exe`（Windows PowerShell 5.1，Win10 自带）跑，
报 `The string is missing the terminator: '.` / `Missing closing '}'`，指向一行完全正常的代码。

原因：5.1 读**无 BOM** 的 `.ps1` 时按 ANSI(GBK) 解码，中文注释里的字节把后面的单引号"吃"掉了。
pwsh 7 默认按 UTF-8 读，所以同一个文件在 7 下没问题——这种"一个 shell 能跑一个不能跑"的坑很难猜。

处理：`desktop/start.ps1` 已存成 UTF-8 with BOM（`EF BB BF`），5.1 与 pwsh 7 的
`Parser::ParseFile` 都验证过解析通过。**以后往 `desktop/` 加 `.ps1` 一律带 BOM。**
t2 补充坑：**编辑器/写入工具保存 `.ps1` 时会剥掉 BOM**（本文件 §3.6 的
`postCloseToQingyin.ps1` 被改了两次、剥了两次），每次编辑完都要重查三字节头并补回。

### 坑 6（t2）：PowerShell 的 `$matches` 是自动变量，不能当数组用

`postCloseToQingyin.ps1` 里用 `$matches += [pscustomobject]@{...}` 收集窗口，报
`A hash table can only be added to another hash table`——`$matches` 是 `-match`
操作符的结果 hashtable（自动变量）。换成 `$hits` 就好。写 PS 时避开
`$matches` / `$args` / `$input` / `$error` 这些自动变量名。

### 坑 7（t2）：CDP 的 `window.close()` 不是用户关窗路径，会绕过 close 事件

`page.evaluate(() => window.close())` 走的是 DevTools 强制关闭路径：直接销毁
WebContents，**不触发** `BrowserWindow` 的 `close` 事件（`preventDefault` 根本没机会跑），
还会触发 `window-all-closed`——测"关窗到托盘"用它会得到假结论（窗口真死了）。
真实用户点 X 的路径是 Win32 `WM_CLOSE (0x0010)` 投到 `Chrome_WidgetWin_1` 顶层窗口，
`desktop/postCloseToQingyin.ps1` 就是干这个的。注意匹配标题要用 `Contains`
不能用 `StartsWith`（播放中标题是 `歌名 - 轻音播放 v0.1.0`）。

### 坑 8（t2，最费解的一个）：DSH 沙箱会降权 Electron 的子进程（写注册表"拒绝访问"）

在本 DSH harness 里启动的 electron（无论 Playwright 还是 node spawn），它再 spawn 的
子进程（reg.exe）**能跑但被降权**：`reg add` 报 `拒绝访问`、`reg export` 连临时
`.reg` 文件都写不了；而 electron 主进程自己写普通文件（settings.json）没问题，
同一条 reg 命令从纯 Node 进程 spawn 则完全正常。叠加发现：

- `app.setLoginItemSettings`（Electron 原生注册表写入）在本环境**静默无效**（三变体
  全不落盘）——见 §8；
- `spawn` 用 `stdio:'ignore'` 会让 electron **直接崩**（0xC0000005），用管道 stdio 则
  只是降权不崩——所以 `autoStart.js` 的 `regRun` 固定用管道；
- `Start-Process` 启动 electron 会把受限 pwsh 会话整个**挂死**（两次复现）。

结论：这是**验证环境的限制，不是代码缺陷**——用户双击启动的 app 没有这层沙箱。
验证桥接方案见 §8。另外：node 直接 spawn electron（stdio ignore）会秒崩 0xC0000005，
裸 `.cjs` 当 app（无 package.json 上下文）也会崩——都别用，统一走 Playwright
`_electron.launch` + 目录方式启动。

### 坑 9（t2）：崩溃的 electron 会留杀不掉的僵尸进程

强杀 pwsh 任务（job_kill）或探针崩了没 `app.close()`，都会留下 `HasExited=True`
但 `Get-Process` 仍列出的僵尸（父进程没了、没人收割）。它们不占端口不占 CPU，
`Stop-Process -Force` 与 `taskkill /F` 都报拒绝访问，重启才消失。每次跑
`checkTray.js` 前先
`Get-Process electron | Where-Object { -not $_.HasExited } | Stop-Process -Force`
清掉**活的**实例（判断"有没有在跑"永远看 `Get-NetTCPConnection -LocalPort 53140 -State Listen`）。

### 坑 10（t2）：`node --test` 的目录形式不能用

`node --test desktop/` 会把目录当单个测试文件加载（非测试模块也被 require，
`require('electron')` 直接炸）。要用文件列表或 glob 引号形式：
`node --test "desktop/*.test.cjs"`（Node 24 会自己展开 glob，npm scripts 里也行）。
另注意根 `package.json` 是 `"type":"module"`，`desktop/` 之外写的临时脚本要存 `.cjs`。

### 坑 11（t6）：Playwright 的 `ElectronApplication.evaluate` 第一个参数**永远是 electron 模块**

类型是 `evaluate<R, Arg>(pageFunction: PageFunctionOn<ElectronType, Arg, R>, arg: Arg)`——
`pageFunction(electron, arg)`，两个参数。所以传参必须写：

```js
// 对：第一个形参接 electron 模块，第二个才是自己的 arg
await app.evaluate((_electron, type) => globalThis.__qingyinDesktopShell.playbackCommand(type), 'next');
// 错：type 收到的是 electron 模块
await app.evaluate((type) => globalThis.__qingyinDesktopShell.playbackCommand(type), 'next');
```

写错的症状很好认：主进程回一句 `不是合法的播放命令：[object Object]`（t6 第一版就撞了，
9 条断言一起红）。页面侧的 `win.evaluate` 没有这个规矩，只有主进程侧有。

### 坑 12（t6）：连着开四次进程，CDP 偶发 `read ECONNRESET`（不是产品问题）

`_electron.launch()` 偶尔在**应用已经正常起来之后**断掉调试通道：日志里
`[desktop] origin = …`、`[desktop] 窗口几何来源 = …` 都打印出来了，随后
`ws disconnected code=1006` / `WebSocket error: read ECONNRESET`，Playwright 抛错、
进程被 force kill（`exitCode=4294967295`）。一个脚本要连开四次进程时撞上的概率不低。
处理：`launch()` 包一层重试（3 次，间隔 2 秒），**每次失败都记进报告的 mainLog**，不装作没发生。

### 坑 13（t6）：几何断言必须按 Windows 的两个真实行为写，否则是假失败

1. `setBounds` 请求的尺寸小于 `minWidth`/`minHeight` 时会被**夹到最小值**：
   请求 `height:584` → 实际存 `600`。验收脚本算目标几何时要 `Math.max(WINDOW_MIN_*, …)`。
2. 最大化 → 还原这一来一回，`getNormalBounds()` 会比原值漂十几个像素
   （本机 125% DPI：`1180x704` → `1198x722`，不可见边框的锅）。位置是准的，尺寸要用宽容差。

这两条都不是 bug，是 Electron/Windows 的既有行为；断言写死了就会红得毫无信息量。

---

## 6. 文件清单

| 文件 | 作用 |
| --- | --- |
| `desktop/package.json` | `main: entry.js`；让 `electron desktop` 可用，并让 `desktop/` 成为 CommonJS 孤岛（根 package.json 是 `"type":"module"`） |
| `desktop/entry.js` | 唯一入口：`--probe` 走探针，否则走 `main.js`。**必须用目录方式启动**，否则 `app.getName()/getVersion()` 会退化成 `Electron` / `44.9.1`（实测），版本号那一栏就是错的 |
| `desktop/constants.js` | `APP_ID`、`PORT=53140`、`ORIGIN`、`APP_ORIGIN`、IPC 通道名等所有常量 |
| `desktop/httpUtils.js` | MIME 表（与 `scripts/check-ui.mjs` 对齐 + 音频类型）、`isInside`、`parseRange`、`cacheControlFor` |
| `desktop/staticServer.js` | 方案 (a)：只绑 127.0.0.1 的静态服务，Host 头校验、防穿越、206/Range、`EADDRINUSE` 不回退 |
| `desktop/appProtocol.js` | 方案 (b)：`app://` 协议（`registerSchemesAsPrivileges` 必须在 ready 之前调） |
| `desktop/userData.js` | 选定并钉死 userData（§5 坑 3 的全部应对都在这里） |
| `desktop/window.js` | `BrowserWindow` 参数：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`、拒绝 `window.open` |
| `desktop/preload.js` | `contextBridge` 暴露面（现在是探针用的两个方法，注释里写了目标形状） |
| `desktop/mainIpc.js` | `desktop:info` / `desktop:echo-bytes` 两个 IPC，用来验桥与二进制传输 |
| `desktop/main.js` | 正式启动：dist 检查 → 起服务 → 装 IPC → 开窗 → 单实例锁 → 退出时关服务 |
| `desktop/probe.js` | origin 持久性实验的探针入口（两阶段、截图、userData 目录清点、报告 JSON） |
| `desktop/runProbe.js` | 探针驱动：spawn 两个独立进程、解析报告、打印中文读数、做前后对比 |
| `desktop/checkWindow.js` | 用 playwright-core 的 `_electron.launch()` 驱动**真入口**，断言列表渲染出来了 |
| `desktop/checkDirectoryPicker.js` | §3.5 的实验：真实点击「选择音乐文件夹」，驱动原生目录对话框，断言曲库扫进来（22 首 / 16 歌词） |
| `desktop/driveFolderDialog.ps1` | 用 EnumWindows + Win32 消息驱动原生「选择文件夹」对话框（§3.5 的坑 1-5 全在里面） |
| `desktop/snapshotDesktop.ps1` | 桌面快照：全屏截图 + EnumWindows 全量可见顶层窗口转储（排原生对话框问题的第一步） |
| `desktop/installElectron.js` | 补下 Electron 二进制（§5 坑 4） |
| `desktop/start.ps1` | 一键启动，自动处理坑 1 与坑 2 |
| `desktop/smoke.js` / `desktop/smoke2.js` | 崩溃二分器（§5 坑 3 的证据来源）。换机器排障时还有用，所以留着 |

t2 新增/修改（壳层五件套）：

| 文件 | 作用 |
| --- | --- |
| `desktop/main.js`（改） | 五件套总装：userData 钉死、settings 载入、`close` 拦截成 hide、`page-title-updated` 原生标题带版本、单实例锁 + 二启唤回、托盘装配、自启同步（§8）、`window-all-closed` 保进程、`will-quit` 清理、`__qingyinDesktopShell` 验证句柄 |
| `desktop/appVersion.js`（新） | 纯函数：读根 `package.json` 的 version（单测覆盖） |
| `desktop/shellSettings.js`（新） | 纯函数：`userData/settings.json` 的 load/save（原子写、未知键丢弃、单测覆盖） |
| `desktop/shellText.js`（新） | 纯函数：托盘 tooltip / 原生标题拼版本号（幂等，单测覆盖） |
| `desktop/trayMenu.js`（新） | 纯函数：托盘菜单模板（不含 handler，接线归 tray.js，单测覆盖） |
| `desktop/tray.js`（新） | Electron 侧：Tray 创建/刷新/销毁、点击行为、`describe()` 菜单快照（验证用） |
| `desktop/autoStart.js`（新） | Windows 自启：自管 HKCU Run + StartupApproved（§8），`reg export` 精确读回 + `reg query` 存在性兜底（单测含真注册表读写往返） |
| `desktop/window.js`（改） | `createMainWindow` 接受 `title` 选项 |
| `desktop/checkTray.js`（新） | t2 全量验证脚本（§3.6，报告落 `artifacts/desktop/tray-check.json`） |
| `desktop/postCloseToQingyin.ps1`（新） | 向轻音主窗口投递真实 WM_CLOSE（坑 6/7 的经验都在里面） |
| `desktop/appVersion.test.cjs` / `shellSettings.test.cjs` / `shellText.test.cjs` / `trayMenu.test.cjs` / `autoStart.test.cjs`（新） | 43 个单测（`npm run test:desktop`） |

t3 新增（验收）：

| 文件 | 作用 |
| --- | --- |
| `desktop/verify.mjs`（新） | 总验收脚本：t3 四条（窗口+列表 / 双击真播放 / 歌词面板 / 隐藏后继续播，含 EnumWindows 证据与暂停反证、托盘退出）+ t7 三组（补歌词成功/失败/取消、隐藏态托盘播放控制、窗口状态记忆四轮重启）；报告落 `artifacts/desktop/verify.json`，按 `assertionSummary` 分「沿用/新增」 |
| `desktop/verify.md`（新） | 自动化的判定细节（含 t7 第 2.6–2.9 节）+ 人工清单：t3 四项（第 3 节）、t6 两项（第 5 节）、t7 三项（第 6 节：真实 LyricFlow、托盘文案观感、多显示器拔插） |

t5 新增/修改（补歌词，详见 §9）：

| 文件 | 作用 |
| --- | --- |
| `desktop/tools/fill-lyrics.ps1`（新） | 内置工具脚本：artifacts\lyricflow 的 venv python `-m src.main` + 根 README 实测过的那套环境变量；venv 缺失 → exit 2 + 安装指引；MusicPath 无效 → exit 3；退出码透传，UTF-8 输出 |
| `desktop/tools/fake-fill-lyrics.ps1`（新） | 假工具（测试用）：给曲库里一首没有 .lrc 的音频写一个内容确定的 .lrc；exit 0/3/4；`-DelaySec` 供取消测试 |
| `desktop/lyricsTool.js`（新） | 执行器：spawn powershell **无 shell**（纯 argv，无注入面）、尾部 40 行日志、`taskkill /T /F` 取整棵树、15 分钟超时、idle→running→done/failed/**cancelled** 状态机（cancelled 为独立终态 + 运行代号 token 防迟到事件污染，单测真实跑 powershell） |
| `desktop/lyricsIpc.js`（新） | `lyrics:run/status/cancel` IPC + 路径解析（settings.musicFolderPath，没有就弹一次主进程目录对话框并存档）+ 工具脚本选择：**t9 语义**——`resolveLyricsToolScript` 纯函数（空 = 内置、存在 = 自定义、**非空但不存在 = 快速失败**带路径错误，绝不静默回退）+ `musicFolderProblem`（存档是文件不是目录 → 带路径快速失败）；预检失败经 `runner.failFast` 落状态机（failed + 可读错误，不 spawn 任何进程） |
| `desktop/preload.js`（改） | `window.qingyinDesktop.lyrics`：run/status/cancel/onStatus/getTrackPath |
| `desktop/trayMenu.js`（改） | 菜单加「补歌词…（状态化文案）/指定音乐文件夹…/选择补歌词工具…」 |
| `desktop/main.js`（改） | boot 装 lyricsIpc、托盘三项回调、shell 句柄加 `triggerFillLyrics/lyricsState/chooseLyrics*`、will-quit 杀运行中的工具进程树 |
| `desktop/checkPathForFile.js`（新） | §9.1 的前置验证脚本（报告 `artifacts/desktop/path-for-file.json`） |
| `desktop/checkLyricsTool.js`（新） | §9.4 的 E2E（报告 `artifacts/desktop/lyrics-tool.json`） |
| `desktop/lyricsTool.test.cjs` / `shellSettings.test.cjs`（改） | runner 单测（真实 powershell，含 failFast 预检失败不启进程）+ settings 三键/部分更新断言；另有 `lyricsIpc.test.cjs`（新，t9）：resolver 三分支（空→内置、存在→自定义、不存在→错误**不返回内置**）+ 音乐文件夹预检 |
| `src/ui/desktopLyrics.ts`（新） | 渲染进程胶水：订阅状态推送，done → 自动 `rescanLyrics()` + 通知；幂等 init，桥不存在零副作用（单测 8 项） |
| `src/ui/LyricsPanel.tsx`（改） | 空状态加「用补歌词工具」按钮 + 状态行（桥不存在时**不渲染**，非禁用） |
| `src/main.tsx`（改） | +2 行：import + `initDesktopLyrics()` |
| `src/ui/store.ts`（改） | `rescanLyrics` 修复（§9.3）：重扫前重新遍历目录，扫描后写入的 .lrc 真能认领 |

t6 新增/修改（托盘播放控制 + 窗口状态记忆，详见 §3.8）：

| 文件 | 作用 |
| --- | --- |
| `desktop/playbackStatus.js`（新） | 纯函数：上报状态规范化（垃圾值一律降级成"未知"，计数只认非负整数）、菜单相关切片比较、`play-pause` 文案、命令白名单判定（单测 12） |
| `desktop/windowState.js`（新） | 纯函数：几何规范化、workArea 重叠判定、启动几何决策（`resolveStartupWindow`，越界回退主屏居中）、`captureWindowState`（最大化取 normalBounds / 最小化返回 null）、防抖+去重写盘器（单测 32） |
| `desktop/constants.js`（改） | 加 `IPC_SHELL_COMMAND` / `IPC_SHELL_STATUS` / `SHELL_COMMAND_TYPES` / `WINDOW_MIN_*` / `WINDOW_DEFAULT_*` |
| `desktop/trayMenu.js`（改） | 菜单插「播放/暂停（随状态换文案）、上一首、下一首」，无当前曲目时三项禁用；t5 的补歌词分组原样保留 |
| `desktop/tray.js`（改） | `refresh()` 带上 `getPlayback()`；三个新 id 接到 `onPlaybackCommand(type)` |
| `desktop/preload.js`（改） | `onCommand(cb)`（返回取消订阅、回调抛错不外泄）+ `reportStatus(status)`（只过桥四个已知键） |
| `desktop/shellSettings.js`（改） | 第四个键 `windowState`（load 时规范化，旧存档 → null；save 沿用部分更新语义） |
| `desktop/window.js`（改） | `createMainWindow` 接受 `x/y/width/height/minWidth/minHeight`（只接受调用方校验过的几何） |
| `desktop/mainIpc.js`（改） | `ipcMain.on('shell:status')` → `context.onShellStatus(payload)`（重复装配不叠层） |
| `desktop/main.js`（改） | 播放状态存放 + `sendPlaybackCommand`（白名单 + `webContents.send`）+ 启动几何决策 + 5 个几何事件的防抖保存 + 真退出/`will-quit` flush + shell 句柄加 `playbackCommand/readPlaybackStatus/readWindowState/saveWindowStateNow` |
| `desktop/checkTrayPlayback.js`（新） | §3.8.3 的验收脚本一（隐藏状态下四条命令 + 白名单反证），报告 `artifacts/desktop/tray-playback-check.json` |
| `desktop/checkWindowState.js`（新） | §3.8.3 的验收脚本二（四次真实启动：记住/恢复/最大化/两种屏幕外回退），报告 `artifacts/desktop/window-state-check.json` |
| `desktop/checkTray.js`（改） | 菜单结构断言从"精确全列表"换成不变式（必备 id 全集 + `quit` 收尾 + id 不重复 + 分隔条数），其余断言一条没删——这个脚本不在 `node --test` 范围内，精确比对每加一个菜单项就红一次而没人知道 |
| `desktop/playbackStatus.test.cjs` / `windowState.test.cjs` / `channels.test.cjs`（新） | 12 + 32 + 8 个单测；`channels.test.cjs` 是把五份源码当文本读的**防漂移**锁（通道名/白名单/字段名一致，且渲染侧不许出现 `getAudioElement`、`useAppStore.setState`） |
| `desktop/shellSettings.test.cjs`（改） | +6：windowState 往返、旧存档兼容、脏结构丢成 null、部分更新双向、显式 null 可清除 |
| `src/ui/desktopShell.ts`（新） | 渲染侧唯一新文件：命令 → 只调 store 既有动作；`store.subscribe` → 只在四字段切片变化时上报；桥不存在时**在订阅之前**就 return；模块级 guard 保证幂等 |
| `src/ui/desktopShell.test.ts`（新） | 15 个用例，对应 §3.8.4 的四条硬约束 |
| `src/main.tsx`（改） | +2 行（与 t5 的 `initDesktopLyrics()` 并存）：import + `startDesktopShell()` |

**t6 没动过**：`src/ui/store.ts`、`src/core`、`src/platform`、`scripts/`、`vite.config.ts`、
根 `package.json`（一个脚本都没加，`test:desktop` 的 glob 自动带上新增的 `.test.cjs`）、
以及 `desktop/` 之外除 `src/main.tsx` 两行与 `src/ui/desktopShell*.ts` 以外的任何文件。

**没动过**：`src/core`、`src/platform`（`src/ui/store.ts` 的 `rescanLyrics` 与 LyricsPanel/
desktopLyrics 除外，见上表与 §9.3——那是 t5 的最小必要接缝）、`scripts/`、
`vite.config.ts`、`package.json` 里已有的脚本（t2 只**新增**了 `"test:desktop"`）。

---

## 7. 遗留风险 / 交给实现阶段的清单

1. **`--no-sandbox` 是安全降级**（坑 2）。干净机器上必须复测；打包版要带这个参数的话只能靠启动器 re-exec。
2. **userData 降级**（坑 3）：本机数据落在 `artifacts/desktop/userdata/`。
   打包发布前要确认目标机器 `%APPDATA%` 可写，否则每个用户都会掉进降级路径；
   降级警告要能在界面上看到，不能只在控制台。
3. **Service Worker 会接管页面**（方案 a 实测 `controlled:true`）。桌面端升级后可能拿到旧外壳，
   实现阶段要么让 `/sw.js` 返回 404，要么启动时清 SW 存储。
4. **没有 CSP**（Electron 每次启动都警告）。我们的静态服务正好能下发响应头，建议实现阶段补上。
5. ~~**`showDirectoryPicker` 在壳里存在但未验证能否弹窗**（§3）~~。
   **已实测（§3.5）：能弹、能选、能扫描，桌面端不需要 fs 桥也能用。**
6. ~~**托盘 / 关窗到托盘 / 单实例 / 开机自启 / 版本号界面全部未做**~~。
   **t2 已做完并全量验证（§3.6）**；`app.setLoginItemSettings` 的替代方案与验证桥见 §8。
7. ~~当前 `window-all-closed` 是 `app.quit()`，实现"关窗到托盘"时要改成只隐藏窗口~~。
   **已改**：`window-all-closed` 现在只警告不退出（托盘 + 后台播放保活），
   真退出走托盘菜单「退出」/ `before-quit`。
8. **开机自启的打包态没测过**：`loginItemArgs()` 打包后返回 `[]`（直接 `app.exe`），
   命令拼装逻辑一样，但没有打包产物可验——留给发布阶段（当前不做打包）。
9. **注册表写入的"用户双击"路径没法在本 harness 内验证**（坑 8 的降权），
   node 桥证明了命令与读写逻辑（§8），真人路径留给 t3 人工清单。
10. Service Worker 与 CSP 的遗留项见 §7.3/§7.4，未动。
11. **几何只在"真退出"时保证落盘**（t6）：防抖窗口 600ms，进程被强杀（任务管理器 /
    断电 / 崩溃）时最后一次拖动可能丢。设计上接受这个代价——"每次像素变动都写盘"
    换来的是拖动全程的磁盘抖动，不值。
12. **托盘播放三项依赖渲染进程活着**（t6）：渲染进程崩溃后 `webContents.send` 无处可送，
    `sendPlaybackCommand` 返回 `{ok:false, reason:'主窗口不存在…'}` 并打日志；菜单会停在
    最后一次上报的状态（因为没人再上报）。走 `showMainWindow()` 的兜底重建之后，
    渲染侧会重新上报，状态自动恢复。

---

## 8. 开机自启：为什么不用 `app.setLoginItemSettings`，以及怎么验证的（2026-10-22 调查记录）

### 8.1 官方 API 静默失效（三个变体全试过）

`app.setLoginItemSettings({ openAtLogin: true })` 及其变体（显式 `path`+`args`、
显式 `name: 'qingyin-player'`、外加先 `app.setAppUserModelId`）在 Electron 44.9.1
本机实测**全部静默无效**：

- `HKCU\...\CurrentVersion\Run` 一个新值都没有（reg query 全量核对过）；
- `HKCU\...\Explorer\StartupApproved\Run` 同样没有；
- `schtasks` 里也没有对应计划任务；
- `getLoginItemSettings({path, args})` 读回永远是 `openAtLogin:false`、
  `launchItems: []`、`executableWillLaunchAtLogin:false`。

对照：electron.exe 二进制里确实存在 `Software\Microsoft\Windows\CurrentVersion\Run`、
`...\Explorer\StartupApproved\Run`、`user`/`machine` 与 `electron.app.$1` 模板字符串
（UTF-16 字符串扫描），说明实现代码在；同机上另一个老版本 Electron 应用
（方格音乐）当年就写成了 `electron.app.方格音乐`。为什么 44.9.1 在我们的开发态
不落盘，没有结论（44 的 login items 刚重构过，`Settings` 接口新增了 `name`/`enabled`，
读侧只剩 `path`/`args`）。**与其赌上游，不如自己写**——这就是 `desktop/autoStart.js`。

### 8.2 自管 Run 项的设计

- 值名固定 `qingyin-player`（`constants.APP_ID`）；
- Run 值 = `"<process.execPath>" [args…]`（`buildRunCommand`：exe 恒定加引号，
  含空格/中文的参数也加引号；未打包时 args = `["<desktop 目录>", "--no-sandbox"]`，
  打包后为 `[]`）；
- 同步写 `StartupApproved\Run` 同名 `REG_BINARY` = `02 00 00 00 …`（"已启用"，
  与任务管理器的启动应用列表显示一致）；
- 读回用 `reg export` 到临时文件再按 UTF-16LE 解析（`.reg` 转义还原）——
  **不能用 `reg query` 的 stdout 做精确比对**：它走 OEM 代码页，中文路径必乱码；
  存在性检查（`readLoginItemPresent`）才用 `reg query`；
- 删除 = 两个键的同名值都删（值本来就不存在也算成功）；
- 开关状态真源是 `userData/settings.json`（`shellSettings.js`），OS 侧尽力同步、
  失败不抛给 UI（记日志，下次切换重试）。

### 8.3 验证桥接（为什么 checkTray 里注册表是 node 侧写的）

坑 8：DSH 沙箱会把 harness 内 electron 的子进程降权（reg 写"拒绝访问"），app 侧
写注册表在这个环境里**注定失败**——但用户双击启动的 app 没有这层限制。所以
`checkTray.js` §5 分两层验：

1. **app 层**（证明开关行为）：`setOpenAtLogin(true)` → settings.json 写入且读回、
   托盘菜单勾选、`readState().loginItemCommand` 报出将要写入的完整命令；
   写入失败会在主进程日志留痕（"注册表自启写入失败"）。
2. **node 桥层**（证明注册表写入与读回本身）：用 app 报出的同一份命令，在
   node 侧（不受降权影响）调用**同一个 `autoStart.js` 模块**执行
   `enableLoginItem` → `readLoginItemCommand` 精确比对 → 独立 `reg query` 复核 →
   `StartupApproved` 存在 → 再让 app 侧 `readOsOpenAtLogin()`（存在性模式）感知到 →
   复位时 node 侧删值、读回为空。

也就是说：**命令怎么拼（app 算的）、注册表怎么写怎么读回（同模块跑）两条都验了**，
唯一没法在本环境内证明的只剩"harness 外的 electron 进程有权限执行这个 spawn"——
这层留给 t3 的人工清单（托盘勾选 → 任务管理器看启动应用状态）。

### 8.4 复现调查的探针已清理

调查期间用的临时探针（`artifacts/desktop/tmp-login-*.cjs`、`tmp-auto-*.cjs`、
`tmp-probe*.cjs`、`tmp-binary-strings.cjs` 等）验证完已删除；结论都在本节与坑 8 里。

---

## 9. t5 补歌词：外部工具一键调用 + 自动认领（2026-10-22）

目标：**播放器不自己抓歌词**（产品原则），一键调外部工具（LyricFlow）批量补，
工具写出的 `.lrc` 由播放器的既有认领机制接住。入口两个：托盘菜单「补歌词…」、
歌词面板空状态的「用补歌词工具」按钮（后者只在桌面端渲染——桥不存在时
DOM 都不出现，不是禁用）。

### 9.1 前置验证：`webUtils.getPathForFile` 对句柄来源的 File 返回空串

任务书要求先验证再定方案。`desktop/checkPathForFile.js`：真实点击「选择音乐
文件夹」→ 驱动原生对话框选 `artifacts/desktop/path-probe-music` → 从 IndexedDB
取回目录句柄 → 第一个文件的 File（3.9MB，名字/大小都对，是**真**磁盘文件）→
`window.qingyinDesktop.lyrics.getTrackPath(file)`：

```text
diskPath: ""     ← 句柄来源的 File 反查不出路径
fakePath: ""     ← 内存构造的 File 同样空串（这条是文档行为）
```

结论：**Electron 44.9.1 的 webUtils 只认拖拽/file-input 背书的 File**，File
System Access 句柄的 File 拿不到绝对路径。方案退到任务书里的备选：
`settings.musicFolderPath` + 主进程原生目录对话框（第一次触发补歌词时弹**一次**，
选完存档，之后不再问）；托盘另有「指定音乐文件夹…」显式入口。
preload 仍保留 `getTrackPath`（行为可查 + 将来若换曲库来源可直接启用）。
报告：`artifacts/desktop/path-for-file.json`。

### 9.2 链路（全部真实路径，无捷径）

```text
托盘「补歌词…」/ 面板按钮
  → 主进程 lyricsIpc.startFill()
      目录：settings.musicFolderPath，没有/失效 → showOpenDialog 选一次并存档
      脚本：settings.lyricsToolPath 空 → 内置 desktop/tools/fill-lyrics.ps1
            （venv python -m src.main）；非空且存在 → 用它（测试指向假工具）；
            非空但不存在 → **快速失败**（t9：绝不静默回退内置）
  → lyricsTool.js spawn powershell（无 shell、argv 数组、UTF-8、日志尾 40 行）
  → 工具退出：0 → done；非 0 → failed（退出码透传，可读错误进日志尾）；
      用户取消 → cancelled（**独立终态**，t8：取消是主动行为不是故障，
      界面显示「已取消」而非「失败」，error 为 null）
  → 状态推送 lyrics:status-changed（隐藏窗口也收得到，音乐不停）
  → 渲染进程 src/ui/desktopLyrics.ts：done → store.rescanLyrics()
      （重新遍历目录 → 认领新 .lrc →「歌词：认领 N 首」通知）
```

安全/健壮性要点：spawn **不带 shell**（曲库路径是单个 argv 元素，无注入面）；
取消走 `taskkill /PID <pid> /T /F`（powershell 是包装进程，只 kill 它会让
python 变孤儿）；默认 15 分钟超时；`will-quit` 时杀运行中的工具树。
**取消语义（t8 修正）**：cancelled 是独立终态且**单一真相**——cancel() 先把
状态机推到终态再杀树，IPC 返回的快照 / status 查询 / 状态推送是同一份；杀树
后子进程**迟到的 close 事件不许改状态**（每轮 spawn 带运行代号 token，旧轮
事件直接丢弃——这同时防住「取消后立刻再跑一轮，旧 close 把新一轮改成
failed」的竞态，单测里有这一幕）。
**静默回退（t9 修正）**：自定义工具路径失效时旧行为是悄悄换内置脚本跑——
假成功（用户以为自己那个工具跑了）+ 报错张冠李戴（「MUSIC_PATH 无效」跟
真正原因无关）。现在 `resolveLyricsToolScript` 三分支：空 = 内置（正常路径，
行为不变）、存在 = 自定义、**非空但不存在 = 快速失败**（failed + 错误文案含
路径与改法「托盘 → 选择补歌词工具… 可重选，或选恢复内置脚本」，不 spawn
任何进程——`runner.failFast` 落状态机，startedAt 保持 null、日志尾为空就是
没跑过进程的证据）；同类地 `musicFolderProblem` 拦「存档路径是个文件」并给
带路径文案（路径不存在仍走目录对话框重选——那是恢复，不是静默回退）。
失败错误必须可读：venv 缺失 → exit 2 + 安装指引全文（LyricFlow 不进 git，
新克隆机器上缺失是**正常路径**，指引比报错有用）；MusicPath 无效 → exit 3。

### 9.3 顺手修掉的预存 bug：`rescanLyrics` 快照失效（web 版同受益）

E2E 第一轮就照出来了：假工具写盘成功、退出码 0、通知出现，**认领数 = 0**。
原因是 `rescanLyrics` 用的 `currentSource` 是扫描时的快照（`sourceFromFiles`
把 File 装进 Map，`listLyricFiles` 只遍历 Map）——扫描**之后**写进目录的
`.lrc` 永远不在快照里。根 README「跑完 LyricFlow → 点重新扫描歌词 →
全部认领」这条流程对扫描后新增的文件实际是失效的（bug 在 web 版就存在，
t5 的自动化验收把它逼了出来）。

修法（只动 `rescanLyrics` 内部，签名/其他 action 未动）：进 `syncLyrics` 前，
持久化句柄存在且 `hasReadPermission`（**queryPermission 只查不请求**，
prompt/denied 一律走快照老路径，绝不弹框）就用现有私有 `collect(handle)`
重新遍历并换掉 `currentSource`；重读失败 try/catch 兜住（保留快照 + 可读通知）；
**零播放打扰**——不碰 controller/引擎/当前曲目。刻意不用现成的
`restoreLibrary()`：它的 `restorePlayback()` 会把正在放的歌重载成**暂停态并
跳回上次落盘位置**，工具跑完那一刻往往正在放歌，那比 bug 更糟。

### 9.4 验证（全部可自动化复现）

```powershell
# 前置验证（§9.1 的证据）
node desktop/checkPathForFile.js      # 报告 artifacts/desktop/path-for-file.json

# 端到端（四幕，全绿才算过）
node desktop/checkLyricsTool.js       # 报告 artifacts/desktop/lyrics-tool.json
```

`checkLyricsTool.js` 四幕（曲库与 userData 都在 `artifacts/desktop/` 下隔离，
真实曲库只被复制读取，**不往 新建文件夹 写任何测试产物**）：

1. **成功链路**：真实目录选择（驱动原生对话框）→ 托盘触发（shell 句柄
   `triggerFillLyrics`，与菜单项同一函数）→ running → done(0) → .lrc 落盘 →
   渲染进程自动认领（`readLyrics` 非空）→ 重扫通知出现 → 双击曲目打开面板
   → **面板里显示假工具写的那句**；
2. **失败传播**：换成 exit 3 的工具 → failed + 退出码透传 + 可读错误进日志尾；
2.5. **工具路径失效（t9）**：存档指向不存在的脚本 → 触发即
   `{ok:false, reason:'tool-script-missing'}` → failed + 错误文案含那个路径 →
   面板状态行看得到 → startedAt=null 且日志尾空（**没有任何进程被启动**，
   没有静默回退去跑内置）；
3. **取消**：30 秒慢工具（先拉一个带 marker 的 venv python 子进程）→ running
   → 渲染进程 `window.qingyinDesktop.lyrics.cancel()` → **独立终态 cancelled**
   （内外状态一致：IPC 快照与轮询结果都是 cancelled、finishedAt 有值、
   error 为 null）→ 面板状态行「已取消」（不带失败字眼）→ 取消后 3 秒查
   进程表：慢工具的 powershell/python **0 残留**（`taskkill /T` 真把树杀干净）。

本环境的重要事实：**坑 8 的"子进程降权"没有拦住 D:\ 上的文件写**（reg 写
HKCU/用户目录 temp 被拒，但 electron→powershell→写 `artifacts/` 完全正常）——
所以补歌词链路在 harness 里全真验证，不需要 node 桥。

单测：`desktop/lyricsTool.test.cjs`（真实 powershell 跑假工具：成功/失败/
守卫/取消/done 后可再跑）、`src/ui/desktopLyrics.test.ts`（8 项：桥缺失零调用、
done 恰好扫一次、running 不扫、failed 不扫、幂等）、shellSettings 三键。
`pnpm verify` 全套 + `pnpm check:ui` 全绿（web 冒烟无回归，按钮在 web 里
根本不渲染）。

### 9.5 真 LyricFlow 的人工验证清单（不自动化：走网络、慢、内容不可控）

1. 准备：`artifacts\lyricflow\.venv\Scripts\python.exe` 存在（本机已装；
   新机器按根 README「给整个曲库补歌词」装好）；
2. 启动桌面端，选一个有几首缺歌词曲目的音乐文件夹；
3. 托盘右键 →「补歌词…」：预期不弹任何目录选择（已选过曲库时
   musicFolderPath 首次会让你指定一次），托盘菜单项变「（运行中）」并禁用，
   歌词面板空状态出现状态行；LyricFlow 的日志滚动进日志尾；
4. 等它跑完：预期状态变 done，面板状态行变「补歌词完成，已重新扫描」，
   弹「歌词：认领 N 首」通知，缺歌词的曲目面板里能显示歌词（对照第 30 秒
   的当前句高亮）；
5. 网络失败/接口 403：预期 failed + 状态行给出日志尾最后一条可读错误；
6. 跑一半点「取消」：预期立即 failed「已取消」，曲库目录里没有半截 .lrc；
7. 删掉 `artifacts\lyricflow`（或改名）再点补歌词：预期 failed 且日志尾
   里有完整的安装指引（exit 2 路径）。
