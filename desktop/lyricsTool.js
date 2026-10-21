'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 补歌词工具执行器（t5）：主进程 spawn powershell 跑外部脚本。
 *
 * 安全与健壮性约定：
 *  - **不带 shell**：spawn(program, [argv...])，曲库路径是一个 argv 元素，
 *    不经过任何字符串拼接 → 没有命令注入面。
 *  - 输出统一 UTF-8（两个 .ps1 都设了 [Console]::OutputEncoding），node 按 utf8 解码。
 *  - 日志只留**尾部** TAIL_LIMIT 行（工具可能刷几千行进度，全存会吃内存）。
 *  - 状态机：idle → running → done（退出码 0）| failed（非 0 / spawn 错误 / 取消 / 超时）。
 *  - 取消走 `taskkill /PID <pid> /T /F`：powershell 是包装进程，python 是它的子进程，
 *    只 kill 直接子进程会让 python 变孤儿继续跑。
 *  - 默认 15 分钟超时：工具卡在网络上时不能永远占着 running 状态（用户还能手动取消）。
 *
 * 纯 Node 模块（不 require electron）：单测在 desktop/lyricsTool.test.cjs
 * （用真实 powershell + fake-fill-lyrics.ps1 跑真退出码）。
 */

const TAIL_LIMIT = 40;
const POWERSHELL_BASE_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
/** 显示给用户的工具标识（状态快照里带，不暴露完整命令行）。 */
const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000;

/**
 * @param {{
 *   defaultScriptPath: string,
 *   maxDurationMs?: number,
 *   onStateChange?: (state: object) => void,
 * }} options
 */
function createLyricsToolRunner(options) {
  const maxDurationMs = options?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  let child = null;
  let timer = null;
  let state = {
    status: 'idle', // idle | running | done | failed
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    scriptLabel: null,
    tail: [],
    error: null,
  };

  function snapshot() {
    return { ...state, tail: [...state.tail] };
  }

  function apply(patch) {
    state = { ...state, ...patch };
    options?.onStateChange?.(snapshot());
  }

  function pushLine(line) {
    apply({ tail: [...state.tail, line].slice(-TAIL_LIMIT) });
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function finish(status, exitCode, error) {
    clearTimer();
    child = null;
    apply({ status, exitCode, finishedAt: Date.now(), error: error ?? null });
  }

  /**
   * 启动一次补歌词。
   * @param {{ scriptPath: string, musicPath: string, scriptLabel?: string }} runOptions
   * @returns {{ started: boolean, reason?: string, status: object }}
   */
  function run(runOptions) {
    if (state.status === 'running') {
      return { started: false, reason: 'already-running', status: snapshot() };
    }
    const scriptPath = runOptions?.scriptPath;
    const musicPath = runOptions?.musicPath;
    if (!scriptPath || !musicPath) {
      return { started: false, reason: 'missing-arguments', status: snapshot() };
    }

    // 状态化"从上一次结果回到 running"：tail 清空重收，exitCode 清空
    state = {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      scriptLabel: runOptions.scriptLabel ?? path.basename(scriptPath),
      tail: [],
      error: null,
    };
    options?.onStateChange?.(snapshot());

    const args = [...POWERSHELL_BASE_ARGS, '-File', scriptPath, '-MusicPath', musicPath];
    try {
      child = spawn('powershell.exe', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish('failed', null, `spawn 失败：${error}`);
      return { started: true, status: snapshot() };
    }

    const decode = (chunk) => chunk.toString('utf8');
    let stdoutRest = '';
    let stderrRest = '';
    child.stdout.on('data', (chunk) => {
      const text = stdoutRest + decode(chunk);
      const lines = text.split(/\r?\n/);
      stdoutRest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) pushLine(line);
    });
    child.stderr.on('data', (chunk) => {
      const text = stderrRest + decode(chunk);
      const lines = text.split(/\r?\n/);
      stderrRest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) pushLine(line);
    });

    child.on('error', (error) => {
      finish('failed', null, `无法启动工具：${error}`);
    });
    child.on('close', (code) => {
      if (stdoutRest.trim()) pushLine(stdoutRest.trimEnd());
      if (stderrRest.trim()) pushLine(stderrRest.trimEnd());
      if (state.status !== 'running') return; // 已经被取消/超时定性过了
      if (code === 0) finish('done', 0, null);
      else finish('failed', code, null);
    });

    clearTimer();
    timer = setTimeout(() => {
      if (state.status !== 'running') return;
      apply({ error: `超过 ${Math.round(maxDurationMs / 60000)} 分钟未完成，自动终止` });
      killTree();
    }, maxDurationMs);
    timer.unref?.();

    return { started: true, status: snapshot() };
  }

  /** 杀整棵进程树（powershell 包装进程 + python 子进程）。 */
  function killTree() {
    const target = child;
    if (!target || target.killed || target.exitCode !== null) return;
    try {
      target.kill();
    } catch {
      // 直接 kill 失败也继续尝试 taskkill
    }
    const killer = spawn('taskkill', ['/PID', String(target.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      // taskkill 不可用时只能靠上面的 kill 兜底
    });
  }

  /**
   * 用户主动取消。
   * @returns {{ cancelled: boolean, status: object }}
   */
  function cancel() {
    if (state.status !== 'running') {
      return { cancelled: false, status: snapshot() };
    }
    apply({ error: '已取消' });
    killTree();
    // close 事件会随后把状态定成 failed（exitCode 非 0）
    return { cancelled: true, status: snapshot() };
  }

  return { run, cancel, status: snapshot };
}

module.exports = { createLyricsToolRunner, TAIL_LIMIT, DEFAULT_MAX_DURATION_MS };
