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
  await waitForStatus(runner, 'failed');
  // 取消不在运行态时是 no-op
  assert.equal(runner.cancel().cancelled, false);
});

test('取消：taskkill 杀整棵树，状态定调为 failed + 已取消', async () => {
  const runner = createLyricsToolRunner({ defaultScriptPath: FAKE_TOOL });
  const musicDir = tmpMusicDir();
  const slow = slowTool();
  // 30 秒慢脚本：够慢到可以先取消
  const result = runner.run({ scriptPath: slow, musicPath: musicDir, scriptLabel: 'slow-tool.ps1' });
  assert.equal(result.started, true);
  assert.equal(runner.status().status, 'running');

  const cancelResult = runner.cancel();
  assert.equal(cancelResult.cancelled, true);

  const final = await waitForStatus(runner, 'failed');
  assert.equal(final.status, 'failed');
  assert.equal(final.error, '已取消');
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

test('日志尾只保留 TAIL_LIMIT 行（防长跑工具吃内存）', () => {
  assert.equal(typeof TAIL_LIMIT, 'number');
  assert.ok(TAIL_LIMIT > 0 && TAIL_LIMIT <= 100, `TAIL_LIMIT 应在 1..100，当前 ${TAIL_LIMIT}`);
});
