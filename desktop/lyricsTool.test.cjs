'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createLyricsToolRunner, TAIL_LIMIT } = require('./lyricsTool.js');

const FAKE_TOOL = path.join(__dirname, 'tools', 'fake-fill-lyrics.ps1');

/** 30 秒慢脚本（ASCII 内容，无需 BOM）：守卫/取消测试需要"正在跑"的状态窗口。 */
function slowTool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-slow-tool-'));
  const script = path.join(dir, 'slow-tool.ps1');
  fs.writeFileSync(
    script,
    "Write-Output 'SLOW started'\nStart-Sleep -Seconds 30\nWrite-Output 'SLOW finished'\nexit 0\n",
    'utf8',
  );
  return script;
}

function tmpMusicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-lyrics-runner-'));
  fs.writeFileSync(path.join(dir, '测试曲.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  return dir;
}

/** 等到状态离开某值（或超时）。 */
async function waitForStatus(runner, target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = runner.status();
  while (Date.now() < deadline) {
    if (last.status === target) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = runner.status();
  }
  return last;
}

test('成功路径：running → done（exitCode 0），日志尾收得到 UTF-8 中文行', async () => {
  const events = [];
  const runner = createLyricsToolRunner({
    defaultScriptPath: FAKE_TOOL,
    onStateChange: (state) => events.push(state.status),
  });
  const musicDir = tmpMusicDir();

  const result = runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  assert.equal(result.started, true);
  assert.equal(runner.status().status, 'running');

  const final = await waitForStatus(runner, 'done');
  assert.equal(final.status, 'done', `最终状态：${JSON.stringify(final)}`);
  assert.equal(final.exitCode, 0);
  assert.ok(final.tail.some((line) => line.includes('FAKE-FILL wrote')), '日志尾应包含工具输出');
  assert.ok(final.tail.some((line) => line.includes('测试曲')), '中文输出按 UTF-8 正确解码');
  assert.ok(fs.existsSync(path.join(musicDir, '测试曲.lrc')), '假工具确实写了 .lrc');

  // 状态推送序列：至少一次 running + 一次 done
  assert.ok(events.includes('running') && events.includes('done'));
  // 快照不可被外部改坏（渲染进程拿到的是推送副本）
  const snapshot = runner.status();
  snapshot.status = 'hacked';
  assert.equal(runner.status().status, 'done');
});

test('失败路径：工具退出码 3 → failed 且退出码透传', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const result = runner.run({ scriptPath: FAKE_TOOL, musicPath: path.join(os.tmpdir(), '不存在的目录-' + Date.now()) });
  assert.equal(result.started, true);

  const final = await waitForStatus(runner, 'failed');
  assert.equal(final.status, 'failed');
  assert.equal(final.exitCode, 3);
  assert.ok(final.tail.some((line) => line.includes('不是有效目录')), '可读错误进日志尾');
});

test('参数缺失：不启动，状态保持 idle', () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const missing = runner.run({ scriptPath: '', musicPath: 'D:\\x' });
  assert.equal(missing.started, false);
  assert.equal(missing.reason, 'missing-arguments');
  assert.equal(runner.status().status, 'idle');
});

test('运行中守卫：第二次 run 被拒绝（already-running），不会并行起两个工具', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const musicDir = tmpMusicDir();
  const slow = slowTool();
  const first = runner.run({ scriptPath: slow, musicPath: musicDir });
  assert.equal(first.started, true);

  const second = runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  assert.equal(second.started, false);
  assert.equal(second.reason, 'already-running');

  // 收尾：取消慢脚本（顺带验证取消路径），别让测试挂着 30 秒
  runner.cancel();
  await waitForStatus(runner, 'cancelled');
  // 取消不在运行态时是 no-op（幂等）
  assert.equal(runner.cancel().cancelled, false);
});

test('取消是独立终态 cancelled（t8）：不是 failed，内外单一真相', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const musicDir = tmpMusicDir();
  const slow = slowTool();
  // 30 秒慢脚本：够慢到可以先取消
  const result = runner.run({ scriptPath: slow, musicPath: musicDir, scriptLabel: 'slow-tool.ps1' });
  assert.equal(result.started, true);
  assert.equal(runner.status().status, 'running');

  const cancelResult = runner.cancel();
  // 单一真相：cancel 的返回值、status() 查询、之后的推送必须是同一个终态——
  // 不允许再出现"外层一个状态 / 内层 running"两个 source of truth
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.status.status, 'cancelled', 'cancel 返回的快照必须是终态');
  assert.ok(cancelResult.status.finishedAt !== null, 'cancelled 是终态：finishedAt 有值');
  const after = runner.status();
  assert.equal(after.status, 'cancelled');
  assert.equal(after.error, null, '取消不是故障：error 不带「已取消」的失败语义');

  // 杀树之后子进程的 close 事件还会来（最容易漏的竞态）：状态必须保持 cancelled，
  // 不能被 close 改回 failed/done/running
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const settled = runner.status();
  assert.equal(settled.status, 'cancelled', `close 事件后状态被改了：${JSON.stringify(settled)}`);
});

test('重复取消是幂等的（已取消之后再调是 no-op，不报错不变状态）', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const musicDir = tmpMusicDir();
  runner.run({ scriptPath: slowTool(), musicPath: musicDir });
  assert.equal(runner.cancel().cancelled, true);

  const second = runner.cancel();
  assert.equal(second.cancelled, false, '第二次取消是 no-op');
  assert.equal(second.status.status, 'cancelled', '状态保持在 cancelled 终态');
});

test('cancelled 是终态但不能卡死：可以再启动新一轮', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const musicDir = tmpMusicDir();

  runner.run({ scriptPath: slowTool(), musicPath: musicDir });
  runner.cancel();
  assert.equal(runner.status().status, 'cancelled');

  // 取消之后立即可再跑（比如用户发现选错目录，取消换参数再来）。
  // 关键：旧一轮被杀进程的迟到 close 事件不许把新一轮的状态改坏（t8 竞态）。
  const next = runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  assert.equal(next.started, true, 'cancelled 之后必须能再次启动');
  assert.equal(next.status.status, 'running');
  // 慢工具没写文件 → 这轮假工具真的写（exit 0），不是 exit 4
  const final = await waitForStatus(runner, 'done');
  assert.equal(final.status, 'done', `新一轮的终态：${JSON.stringify(final)}`);
  assert.equal(final.exitCode, 0);
  assert.ok(fs.existsSync(path.join(musicDir, '测试曲.lrc')), '第二轮确实把 .lrc 写出来了');
});

test('取消真的杀掉整棵进程树：powershell 的子进程不能变孤儿', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-tree-kill-'));
  // marker 必须出现在**子进程的命令行**里（python -c 的参数），进程表才能查到它：
  // 只写进脚本正文（Write-Output）是查不到的——那条只进日志。
  const marker = `treekill${process.pid}_${Date.now()}`;
  const script = path.join(dir, 'tree-slow.ps1');
  const venvPython = path.join(__dirname, '..', 'artifacts', 'lyricflow', '.venv', 'Scripts', 'python.exe');
  // 优先用 venv 的真 python（和 LyricFlow 的真实形状一致：powershell 包一层，python 是孙进程）；
  // 机器上没有 venv 时退化为孙 powershell（同样验证 /T 的递归杀）
  const pyCode = `import time; time.sleep(90) # ${marker}`;
  const childCmd = fs.existsSync(venvPython)
    ? `& '${String(venvPython).replace(/'/g, "''")}' -c '${pyCode.replace(/'/g, "''")}'`
    : `Start-Process powershell -ArgumentList '-NoProfile','-Command','Write-Host ${marker}; Start-Sleep -Seconds 90' -Wait`;
  fs.writeFileSync(
    script,
    `Write-Output 'tree slow started'\n${childCmd}\nWrite-Output 'tree slow finished'\n`,
    'utf8',
  );

  const runner = createLyricsToolRunner({ defaultScriptPath: script });
  runner.run({ scriptPath: script, musicPath: tmpMusicDir() });
  assert.equal(runner.status().status, 'running');

  assert.equal(runner.cancel().cancelled, true);
  // 给 taskkill 一点时间，然后查进程表：命令行带 marker 的进程一个都不许活着
  // （powershell 包装进程带脚本路径，python 孙进程带 marker——两条都查）
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const { execFileSync } = require('node:child_process');
  let pids = '';
  try {
    pids = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*${marker}*' -or $_.CommandLine -like '*${script}*') } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
  } catch (error) {
    assert.fail(`进程表查询失败：${error}`);
  }
  const survivors = pids.split(/\s+/).filter((token) => /^\d+$/.test(token));
  assert.equal(survivors.length, 0, `取消后还有进程活着（marker=${marker}）：${survivors.join(', ')}`);
});

test('上一轮结果能再启动（done 之后可以再跑）', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const musicDir = tmpMusicDir();

  runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  const first = await waitForStatus(runner, 'done');
  assert.equal(first.status, 'done');

  // 第二轮：上次的 lrc 已存在 → 假工具 exit 4（没有可写曲目）
  const second = runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  assert.equal(second.started, true, 'done 之后必须能再次启动');
  assert.equal(second.status.status, 'running');
  const final = await waitForStatus(runner, 'failed');
  assert.equal(final.exitCode, 4);
});

test('failFast（t9）：预检失败不启动任何进程，直接落 failed + 可读错误', async () => {
  const events = [];
  const runner = createLyricsToolRunner({
    defaultScriptPath: FAKE_TOOL,
    onStateChange: (state) => events.push(state.status),
  });
  const musicDir = tmpMusicDir();
  const message = '补歌词工具路径不存在：D:\\不存在\\my-tool.ps1（托盘 → 选择补歌词工具… 可重选，或选「恢复内置脚本」）';

  // running 中不许外部改状态（那是 close/cancel 的地盘）
  runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  assert.equal(runner.failFast(message, 'my-tool.ps1'), false, '运行中拒改');
  const done = await waitForStatus(runner, 'done');
  assert.equal(done.status, 'done', '前置：第一轮正常跑完（有 startedAt/tail 痕迹）');

  // done 之后预检失败：上一轮的痕迹必须被顶掉，这轮**没有任何进程被启动**
  assert.equal(runner.failFast(message, 'my-tool.ps1'), true);
  const state = runner.status();
  assert.equal(state.status, 'failed');
  assert.equal(state.error, message, '错误文案原样落进状态（面板/通知看得到，不只控制台）');
  assert.equal(state.exitCode, null);
  assert.deepEqual(state.tail, [], '日志尾清空：没跑过任何进程');
  assert.equal(state.scriptLabel, 'my-tool.ps1');
  assert.notEqual(state.finishedAt, null);
  assert.ok(events.includes('failed'), '状态推送发生过（广播给渲染进程/托盘）');

  // failFast 后修好配置可以正常再跑新一轮
  const next = runner.run({ scriptPath: FAKE_TOOL, musicPath: musicDir });
  assert.equal(next.started, true);
  await waitForStatus(runner, 'done');
});

test('日志尾只保留 TAIL_LIMIT 行（防长跑工具吃内存）', () => {
  assert.equal(typeof TAIL_LIMIT, 'number');
  assert.ok(TAIL_LIMIT > 0 && TAIL_LIMIT <= 100, `TAIL_LIMIT 应在 1..100，当前 ${TAIL_LIMIT}`);
});
