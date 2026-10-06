/**
 * trace 子命令接线单测（`omniharness trace read --session ID`）。
 *
 * 事故口径（2026-09-19 入口可达性审计）：只读自省 trace 在生产入口不可达。本文件钉住 CLI 侧入口：
 *   ① 真读会话存档并输出稳定 seq 的条目（TSV 与 --json 两种形态）；
 *   ② --kind / --limit 过滤；
 *   ③ 用法错误（缺 --session / 未知子动作）退出码 2；会话不存在退出码 1 且错误如实打到 stderr；
 *   ④ **缺省目录必须与写入方同源**（2026-10-06 第五十九轮实测修正：此前的判据把"工作区相对"当成
 *      正确缺省并标注"与存储层缺省一致"——而写入方用的是用户级目录 ⇒ 默认写入 + 默认读取
 *      **必然找不到会话**。判据自己保护了错误行为，这正是"真实跑测"才能暴露的一类问题）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceCommand } from '../../src/cli/traceCommand.js';
import { CliDefaults } from '../../src/cli/argParser.js';
import { SessionStorageLocation } from '../../src/util/sessionStorageLocation.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 造一条会话事件。 */
const ev = (type: SessionEvent['type'], payload: unknown, at: string): SessionEvent => ({
  id: `e-${type}-${at}`,
  type,
  sessionId: 's1',
  timestamp: at,
  payload,
});

/** 建一个含 `s1.jsonl` 的临时存储目录。 */
async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omni-trace-cli-'));
  const events: readonly SessionEvent[] = [
    ev('user', { content: '开始' }, '2026-09-19T10:00:00.000Z'),
    // tool_call 载荷带 tool/callId：摘要投影（ReadonlyTraceReader.summarize）正是按这两个字段可读化。
    ev('tool_call', { tool: 'read_file', callId: 'c1' }, '2026-09-19T10:00:01.000Z'),
    ev('assistant', { content: '完成' }, '2026-09-19T10:00:02.000Z'),
  ];
  await writeFile(
    join(dir, 's1.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
    'utf8',
  );
  return dir;
}

test('trace read：真读存档并输出稳定 seq 的条目（TSV）', async () => {
  const dir = await seed();
  const out: string[] = [];
  const command = new TraceCommand({ write: (text) => out.push(text), workspace: dir });
  const code = await command.run(['read', '--session', 's1', '--storage-dir', dir]);

  assert.strictEqual(code, 0);
  const text = out.join('');
  assert.match(text, /session\ts1\t3 条/);
  assert.match(text, /2\t2026-09-19T10:00:02\.000Z\tassistant/);
  assert.match(text, /1\t2026-09-19T10:00:01\.000Z\ttool_call/);
  assert.ok(text.indexOf('assistant') < text.indexOf('tool_call'), '新在前');
});

test('④ 缺省存储目录 == 写入方默认（单一事实源；修复前两边不一致 ⇒ 默认写+默认读必失败）', async () => {
  // 一致性地判据本身：`CliDefaults.storageDir`（写入方）必须等于 `SessionStorageLocation.defaultDir()`。
  assert.strictEqual(
    CliDefaults.storageDir,
    SessionStorageLocation.defaultDir(),
    '写入方默认目录与 SessionStorageLocation 分家了',
  );
  // 行为面：把会话放到**默认目录**里，不给 --storage-dir，trace read 必须读得到。
  // 为不污染真实用户目录，用 OMNI_SESSIONS_DIR 把"默认目录"指到临时目录——这正是该环境变量的用途：
  // 一个旋钮同时移动写入方与所有读取方。
  const dir = await mkdtemp(join(tmpdir(), 'omni-trace-default-'));
  const previous = process.env[SessionStorageLocation.ENV_DIR];
  process.env[SessionStorageLocation.ENV_DIR] = dir;
  try {
    const events: readonly SessionEvent[] = [
      ev('user', { content: '默认目录' }, '2026-09-19T11:00:00.000Z'),
    ];
    await writeFile(
      join(dir, 's-default.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n'),
      'utf8',
    );
    const out: string[] = [];
    const command = new TraceCommand({ write: (text) => out.push(text), workspace: dir });
    const code = await command.run(['read', '--session', 's-default']);
    assert.strictEqual(code, 0, `缺省目录下应读到会话：${out.join('')}`);
    assert.match(out.join(''), /session\ts-default\t1 条/);
  } finally {
    if (previous === undefined) delete process.env[SessionStorageLocation.ENV_DIR];
    else process.env[SessionStorageLocation.ENV_DIR] = previous;
  }
});

test('trace read --json --kind --limit：JSON 输出 + 过滤生效', async () => {
  const dir = await seed();
  const out: string[] = [];
  const command = new TraceCommand({ write: (text) => out.push(text), workspace: dir });
  const code = await command.run([
    'read',
    '--session',
    's1',
    '--storage-dir',
    dir,
    '--kind',
    'tool_call',
    '--limit',
    '1',
    '--json',
  ]);

  assert.strictEqual(code, 0);
  const parsed = JSON.parse(out.join('')) as {
    session: string;
    count: number;
    entries: { kind: string; summary: string }[];
  };
  assert.strictEqual(parsed.session, 's1');
  assert.strictEqual(parsed.count, 1);
  assert.strictEqual(parsed.entries.length, 1);
  assert.strictEqual(parsed.entries[0]?.kind, 'tool_call');
  assert.match(parsed.entries[0]?.summary ?? '', /read_file/);
});

test('trace read：用法错误（未知子动作 / 缺 --session）退出码 2', async () => {
  const dir = await seed();
  const command = new TraceCommand({ write: () => undefined, workspace: dir });
  assert.strictEqual(await command.run(['nope']), 2);
  assert.strictEqual(await command.run(['read']), 2);
});

test('trace read：会话不存在退出码 1，且原因如实打到 stderr', async () => {
  const dir = await seed();
  const errors: string[] = [];
  const command = new TraceCommand({
    write: () => undefined,
    writeError: (text) => errors.push(text),
    workspace: dir,
  });
  const code = await command.run(['read', '--session', 'no-such', '--storage-dir', dir]);
  assert.strictEqual(code, 1);
  assert.match(errors.join(''), /trace 读取失败.*未找到/);
});
