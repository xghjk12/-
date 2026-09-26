# 轻音播放

跑在浏览器里的本地音乐播放器。指向自己的音乐文件夹即可播放：**零安装、零上传、不依赖任何在线服务**。

![界面预览](docs/app-preview.png)

产品设计与技术方案见 [docs/](docs/)：

| 文档 | 回答的问题 |
| --- | --- |
| [产品技术文档](docs/产品技术文档.md) | **做什么**：定位、边界、功能清单、里程碑、风险 |
| [技术方案](docs/技术方案.md) | **怎么做**：模块划分、接口、数据结构、算法、性能预算、测试策略 |
| [M0 技术验证结果](docs/M0-技术验证.md) | **凭什么这么做**：实测数据与结论 |

## 快速开始

```bash
pnpm install
pnpm dev            # 打开 http://localhost:5173，点「选择音乐文件夹」
pnpm build          # 产出 dist/（含 PWA 外壳，可安装到桌面）
pnpm verify         # typecheck + 单测 + 产物检查（交付前必跑）
pnpm check:ui       # 本机 Edge 界面冒烟（需要本机装了 Edge）
```

首次使用点「选择音乐文件夹」（Chrome / Edge 走 File System Access API）。
之后每次打开只需点一次「恢复曲库」——浏览器要求一次用户手势重新授权，做不到全自动加载。

## 已实现的范围（M1–M3）

**曲库接入**

- 两条入口统一为 `MusicSource`：`showDirectoryPicker()` 主路 + `<input webkitdirectory>` 回退路
- 三级读取解析元数据：L1 探测 16KB → L2 按容器算准的元数据区 → L3 兜底读整文件
  （实测真实文件只读文件头就够，且排在探测窗口之后的大封面不会被漏掉）
- GBK 老标签保守回退：宁可保留乱码，也不把正常文本改坏
- IndexedDB 增量缓存：二次打开全缓存命中，完全不碰音频文件；删除与孤儿缓存自动清理
- 虚拟化曲目列表 + 中文排序检索；扫描进度可见、可取消

**播放内核**

- `<audio>` + 对象 URL（不把文件读进内存，切歌时 revoke）
- 四种模式：顺序 / 列表循环 / 单曲循环 / 随机（洗牌，不连续重复）
- 单曲循环只在**自然播放结束**时重复本首，手动「下一首」仍前进
- 播放队列抽屉；不可播放格式（APE / DSD / WavPack / ALAC）自动跳过并说明
- MediaSession：系统媒体键与锁屏 / 控制中心
- 快捷键：空格播放暂停、←/→ 快退快进、↑/↓ 切歌、M 静音、Q 队列

**体验收尾**

- 状态持久化：音量、播放模式、当前曲目与进度（节流 + 暂停 / 切歌 / 页面隐藏时补写）
- 目录句柄持久化 + 一键恢复曲库
- PWA：Service Worker 缓存应用外壳，可安装到桌面

## 代码结构

```
src/core/        纯逻辑：格式判定、缓存键、元数据区、GBK 回退、队列与模式、排序检索
src/platform/    平台适配：字节读取、曲库来源、元数据解析、IndexedDB、播放引擎、MediaSession
src/ui/          React 组件 + Zustand store
m0/              M0 手动验证页（pnpm dev:m0）
demo/            交互原型（早期用于定交互，已由 src/ui 取代）
tests/fixtures/  真实音频样本（ffmpeg 生成，已提交，pnpm test 不依赖本机 ffmpeg）
```

依赖方向是硬约束：`ui → platform → core`，**`core` 里不允许出现任何平台 API**。
这条由 `src/core/no-platform-api.test.ts` 用测试强制，而不是靠自觉——它让音频与 DOM 之外的逻辑
可以 100% 单测，也让将来换 UI 框架或上 Electron 不用重写业务逻辑。

## 测试与验证

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # 237 项单测（core / platform / ui playback）
pnpm test:demo      # 37 项交互原型的 node:test 检查
pnpm check:static   # 界面层静态一致性（类名与样式、冒烟选择器）
pnpm check:bundle   # 构建 + 扫产物里的 node: 引用 + PWA 外壳检查
pnpm check:ui       # 真实 Edge 里的界面冒烟（内置自检 + 完整播放链路 + 截图）
```

界面冒烟用 `playwright-core` 驱动**本机已有的 Edge**（不下载 Chromium），它验证的是自动化能覆盖的部分：
页面跑得起来、无控制台报错、内置自检（`?selftest=1`）逐项通过、内置样本能入库并真的出声、
留一张 `artifacts/ui/app.png` 截图。

无法自动化的部分保留手动清单：`showDirectoryPicker()` 的原生弹窗、真实曲库的乱码率、
锁屏媒体键、PWA 安装。详见 [技术方案 9 节](docs/技术方案.md)。

## 平台与限制

- 主支持 Chromium 系（Chrome / Edge）；其它浏览器降级到 `<input webkitdirectory>`，刷新后需重新选择
- APE / WavPack / DSD 等浏览器解不了的格式**明确标记为不支持**，而不是静默失败
- 曲库规模假设数千首：列表已虚拟化，封面走 LRU（约 120 张），扫描单线程异步分片
