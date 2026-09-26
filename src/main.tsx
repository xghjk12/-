/** 应用入口：挂载 React，并在 `?selftest=1` 时运行内置自检。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { startSelfCheck } from './ui/selfCheck.js';
import './ui/styles.css';

const container = document.getElementById('root');

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void startSelfCheck();
