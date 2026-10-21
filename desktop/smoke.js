'use strict';

/**
 * 最小启动烟测：逐条收集环境事实，**每收集一条就立刻落盘**。
 *
 * 为什么要边跑边写：这台机器上 Electron 会在某一步直接硬崩（不是抛 JS 异常），
 * 崩之前没 flush 的 stdout 和没写完的文件全都拿不到，只有增量落盘能看出"死在哪一步"。
 *
 *   node_modules\electron\dist\electron.exe desktop/smoke.js --no-sandbox
 */
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(__dirname, '..', 'artifacts', 'desktop', 'smoke.log');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `--- smoke start ${new Date().toISOString()} ---\n`, 'utf8');

function note(label, fn) {
  let text;
  try {
    text = String(fn());
  } catch (error) {
    text = `THREW ${error && error.message}`;
  }
  fs.appendFileSync(out, `${label}: ${text}\n`, 'utf8');
}

const { app } = require('electron');
note('required electron', () => 'ok');
note('versions.electron', () => process.versions.electron);
note('versions.chrome', () => process.versions.chrome);
note('versions.node', () => process.versions.node);
note('execPath', () => process.execPath);
note('cwd', () => process.cwd());
note('argv', () => process.argv.slice(1).join(' '));
note('env.ELECTRON_RUN_AS_NODE', () => String(process.env.ELECTRON_RUN_AS_NODE));
note('env.USERPROFILE', () => String(process.env.USERPROFILE));
note('env.APPDATA', () => String(process.env.APPDATA));
note('env.LOCALAPPDATA', () => String(process.env.LOCALAPPDATA));
note('env.TEMP', () => String(process.env.TEMP));
note('app.isReady', () => String(app.isReady()));
note('app.getAppPath', () => app.getAppPath());
note('app.getName', () => app.getName());
note('app.getVersion', () => app.getVersion());
note('app.getLocale', () => app.getLocale());
note('getPath(exe)', () => app.getPath('exe'));
note('getPath(module)', () => app.getPath('module'));
note('getPath(temp)', () => app.getPath('temp'));
note('getPath(home)', () => app.getPath('home'));
note('getPath(appData)', () => app.getPath('appData'));
note('getPath(userData)', () => app.getPath('userData'));
note('getPath(desktop)', () => app.getPath('desktop'));
note('setPath(userData)', () => {
  app.setPath('userData', path.join('D:\\', '轻音播放', '.tmp-desktop-userdata'));
  return app.getPath('userData');
});
note('requestSingleInstanceLock', () => String(app.requestSingleInstanceLock()));
note('ALL_DONE', () => 'yes');

app.whenReady().then(() => {
  note('READY', () => 'yes');
  note('getPath(userData) after ready', () => app.getPath('userData'));
  fs.appendFileSync(out, '--- smoke end ---\n', 'utf8');
  app.exit(0);
});
