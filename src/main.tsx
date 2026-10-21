/** 应用入口：挂载 React，装桌面壳的两条接缝，并在 `?selftest=1` 时运行内置自检。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { startSelfCheck } from './ui/selfCheck.js';
import { initDesktopLyrics } from './ui/desktopLyrics.js';
import { startDesktopShell } from './ui/desktopShell.js';
import './ui/styles.css';

const container = document.getElementById('root');

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// 桌面端补歌词桥（t5）：桥不存在（纯 web/PWA）时在注册任何监听之前就 return
initDesktopLyrics();

void startSelfCheck();
