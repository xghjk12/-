/**
 * Service Worker 的注册与更新提示。
 *
 * 为什么从 `registerType: 'autoUpdate'` 改成 `'prompt'`：
 * 静默自动更新有个很坑的后果——**应用外壳被 Service Worker 缓存着，用户打开的仍是旧版本，
 * 而界面上没有任何提示**。这个坑是真实使用反馈暴露的（"没找到歌词的入口"，其实是页面还停在
 * 没有歌词的旧构建上）。所以现在：新版本就绪时显示一条提示，由用户点一下再刷新。
 *
 * 注意这个模块引用了 `virtual:pwa-register`（由 vite-plugin-pwa 提供），
 * 所以它**只能被浏览器入口引用**，不要被单测导入（vitest 里没有这个虚拟模块）。
 */
import { registerSW } from 'virtual:pwa-register';

export interface ServiceWorkerHandle {
  /** 应用更新并刷新页面。 */
  update(): void;
  dispose(): void;
}

export function setupServiceWorker(onNeedRefresh: () => void): ServiceWorkerHandle {
  let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  try {
    updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        onNeedRefresh();
      },
      onRegisteredSW(_url, registration) {
        // 本地应用不会一直开着，每小时问一次足够了
        if (!registration) return;
        timer = setInterval(() => void registration.update(), 60 * 60 * 1000);
      },
    });
  } catch {
    // 不支持 Service Worker 的环境（或非 PWA 构建）直接跳过，不影响使用
  }

  return {
    update: () => {
      void updateSW?.(true);
    },
    dispose: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
