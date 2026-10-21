'use strict';

/**
 * 崩溃二分器：每个 case 单独跑一个进程，逐步把结果 append 到日志。
 *
 * 背景：这台机器上 Electron 44.9.1 在 `app.getPath('userData')` 这一步直接硬崩
 * （不是 JS 异常，进程没了），而 `app.getLocale()` 返回空串。
 * 这个脚本用来定位"到底是哪一步、什么条件下不崩"。
 *
 *   node_modules\electron\dist\electron.exe desktop/smoke2.js --no-sandbox --case=otherPaths
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const caseArg = process.argv.find((item) => item.startsWith('--case='));
const caseName = caseArg ? caseArg.slice('--case='.length) : 'userData';
const out = path.join(__dirname, '..', 'artifacts', 'desktop', 'smoke2.log');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.appendFileSync(out, `\n[${new Date().toISOString()}] case=${caseName} pid=${process.pid}\n`, 'utf8');

function step(label, fn) {
  let text;
  try {
    text = typeof fn === 'function' ? String(fn()) : String(fn);
  } catch (error) {
    text = `THREW ${error && error.message}`;
  }
  fs.appendFileSync(out, `  ${label}: ${text}\n`, 'utf8');
}

const PATH_NAMES = [
  'exe', 'module', 'temp', 'home', 'appData', 'userData', 'sessionData', 'logs',
  'crashDumps', 'cache', 'config', 'desktop', 'documents', 'downloads', 'music',
  'pictures', 'videos', 'recent',
];

let deferExit = false;

switch (caseName) {
  case 'userData':
    step('getPath(userData)', () => app.getPath('userData'));
    break;
  case 'setAscii':
    app.setPath('userData', 'D:\\qingyin-ud-ascii');
    step('getPath(userData) after setPath(ascii)', () => app.getPath('userData'));
    break;
  case 'setNonAscii':
    app.setPath('userData', path.join(__dirname, '..', '.tmp-desktop-userdata'));
    step('getPath(userData) after setPath(非 ascii)', () => app.getPath('userData'));
    break;
  case 'setName':
    app.setName('qingyin-player');
    step('getName', () => app.getName());
    step('getPath(userData)', () => app.getPath('userData'));
    break;
  case 'setBoth':
    app.setName('qingyin-player');
    app.setPath('userData', path.join(__dirname, '..', '.tmp-desktop-userdata'));
    step('getName', () => app.getName());
    step('getPath(userData)', () => app.getPath('userData'));
    break;
  case 'locale':
    step('getLocale', () => app.getLocale());
    step('getSystemLocale', () => app.getSystemLocale());
    step('getPreferredSystemLanguages', () => JSON.stringify(app.getPreferredSystemLanguages()));
    break;
  case 'otherPaths':
    for (const name of PATH_NAMES) step(`getPath(${name})`, () => app.getPath(name));
    break;
  case 'afterReady':
    deferExit = true;
    app.whenReady().then(() => {
      step('READY', true);
      step('getLocale', () => app.getLocale());
      step('getPath(userData)', () => app.getPath('userData'));
      step('getPath(sessionData)', () => app.getPath('sessionData'));
      fs.appendFileSync(out, '  DONE\n', 'utf8');
      app.exit(0);
    });
    break;
  case 'readyOnly':
    deferExit = true;
    app.whenReady().then(() => {
      fs.appendFileSync(out, '  READY-OK\n  DONE\n', 'utf8');
      app.exit(0);
    });
    break;
  case 'readyWithSetPath':
    deferExit = true;
    app.setPath('userData', path.join(__dirname, '..', '.tmp-desktop-userdata'));
    step('setPath 之后 getPath(userData)', () => app.getPath('userData'));
    app.whenReady().then(() => {
      step('READY', true);
      step('getLocale', () => app.getLocale());
      step('getPath(userData)', () => app.getPath('userData'));
      fs.appendFileSync(out, '  DONE\n', 'utf8');
      app.exit(0);
    });
    break;
  case 'readyWithSetPathAscii':
    deferExit = true;
    app.setPath('userData', 'D:\\qingyin-ud-ascii');
    step('setPath(ascii) 之后 getPath(userData)', () => app.getPath('userData'));
    app.whenReady().then(() => {
      step('READY', true);
      step('getLocale', () => app.getLocale());
      fs.appendFileSync(out, '  DONE\n', 'utf8');
      app.exit(0);
    });
    break;
  case 'mkdirTest': {
    // 到底是谁不让建目录：Electron 自己（Node fs）能不能在 %APPDATA% 下写东西？
    const targets = [
      ['appData(roaming)', path.join(app.getPath('appData'), 'qingyin-mkdir-test')],
      ['localAppData', path.join(process.env.LOCALAPPDATA || '', 'qingyin-mkdir-test')],
      ['temp', path.join(app.getPath('temp'), 'qingyin-mkdir-test')],
      ['workspace', path.join(__dirname, '..', '.tmp-desktop-userdata')],
      ['home', path.join(app.getPath('home'), 'qingyin-mkdir-test')],
    ];
    for (const [label, target] of targets) {
      if (!target) continue;
      step(`mkdir ${label}`, () => {
        fs.mkdirSync(target, { recursive: true });
        return target;
      });
      step(`write ${label}`, () => {
        const file = path.join(target, 'probe.txt');
        fs.writeFileSync(file, 'ok', 'utf8');
        return `${file} (${fs.statSync(file).size}B)`;
      });
      step(`rmdir ${label}`, () => {
        fs.rmSync(target, { recursive: true, force: true });
        return 'removed';
      });
    }
    break;
  }
  case 'readyWithSetNameOnly':
    deferExit = true;
    app.setName('qingyin-player');
    app.whenReady().then(() => {
      step('READY', true);
      step('getPath(userData)', () => app.getPath('userData'));
      fs.appendFileSync(out, '  DONE\n', 'utf8');
      app.exit(0);
    });
    break;
  case 'readyWithAppDataJoin':
    // 这正是 main.js / probe.js 用的写法：必须确认它在 ready 阶段也不崩
    deferExit = true;
    app.setName('qingyin-player');
    app.setPath('userData', path.join(app.getPath('appData'), 'qingyin-player'));
    step('目标 userData', () => app.getPath('userData'));
    app.whenReady().then(() => {
      step('READY', true);
      step('getLocale', () => app.getLocale());
      step('userData 目录真的建出来了', () => String(fs.existsSync(app.getPath('userData'))));
      fs.appendFileSync(out, '  DONE\n', 'utf8');
      app.exit(0);
    });
    break;
  case 'window':
    deferExit = true;
    app.commandLine.appendSwitch('no-sandbox');
    app.whenReady().then(() => {
      try {
        // eslint-disable-next-line global-require
        const { BrowserWindow } = require('electron');
        const win = new BrowserWindow({ show: false });
        win.loadURL('data:text/html,<title>t</title><body>hi').then(() => {
          step('window title', () => 'loaded');
          fs.appendFileSync(out, '  DONE\n', 'utf8');
          app.exit(0);
        });
      } catch (error) {
        step('window THREW', () => error.message);
        fs.appendFileSync(out, '  DONE\n', 'utf8');
        app.exit(1);
      }
    });
    break;
  default:
    step('unknown case', caseName);
}

if (!deferExit) {
  fs.appendFileSync(out, '  DONE\n', 'utf8');
  app.exit(0);
}
