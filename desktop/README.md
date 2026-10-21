# desktop/ —— 轻音播放桌面端壳（探路阶段成果）

这一版**只做探路**：证明壳能跑起来、把 origin 定死、拿数据回答"关掉再开数据还在不在"，
以及把文件系统桥（fs 桥）的最小设计写清楚。**托盘 / 关窗到托盘 / 开机自启 / 版本号界面都还没做**，
那是实现阶段的事。

边界：本阶段**没有改动** `src/core`、`src/ui`、`src/platform`，没有改 `package.json` 里任何已有脚本，
只在根 `package.json` 的 devDependencies 里多了一条 `electron`（`pnpm add -D electron` 自己写进去的），
其余全部是 `desktop/` 下的新增文件。`pnpm verify` 全绿：`Test Files 23 passed | 1 skipped`、
`Tests 427 passed | 1 skipped (428)`、产物检查 4/4 通过（日志 `artifacts/desktop/verify.log`）。

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 壳能不能跑 | **能**。`electron desktop --no-sandbox` 开窗，加载 `http://127.0.0.1:53140/`，曲库列表渲染出 4 行 |
| origin 方案 | **选 (a) 主进程静态服务 + 固定 `http://127.0.0.1:53140`**；(b) `app://qingyin` 也实现了、也实测过，作为对照保留 |
| 端口 | **53140，常量，绝不回退**（`desktop/constants.js` 的 `PORT`）。被占用就报错退出，因为换端口 = 换 origin = 用户数据"消失" |
| origin 持久性 | **通过**。进程完全退出后重开，探针记录与 4 首曲目都还在（数据见 §3） |
| fs 桥 | 设计见 §4，**未实现**（按要求只做设计） |
| 本机三个坑 | ① 环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 退化成纯 Node；② 必须命令行传 `--no-sandbox`；③ electron.exe 在用户目录（`C:\Users\...`）下建目录一律 EPERM，必须把 userData 指到可写位置。详见 §5，这三条**实现阶段一定会再踩** |

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

**没动过**：`src/core`、`src/ui`、`src/platform`、`scripts/`、`vite.config.ts`、
`package.json` 里已有的脚本（只有 pnpm 自己往 devDependencies 里写的 `electron` 一行）。

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
6. **托盘 / 关窗到托盘 / 单实例 / 开机自启 / 版本号界面全部未做**。
   单实例锁已经有了（`main.js`），托盘与 `app.setLoginItemSettings` 是新增工作；
   版本号直接用 `app.getVersion()`——但前提是**用目录方式启动**（见 `entry.js` 的注释），否则显示成 `44.9.1`。
7. 当前 `window-all-closed` 是 `app.quit()`，实现"关窗到托盘"时要改成只隐藏窗口，
   并额外处理 `before-quit` / 托盘菜单退出，别让后台播放被顺手杀掉。
