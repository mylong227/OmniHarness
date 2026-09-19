/**
 * trace 子命令接线单测（`omniharness trace read --session ID`）。
 *
 * 事故口径（2026-09-19 入口可达性审计）：只读自省 trace 在生产入口不可达。本文件钉住 CLI 侧入口：
 *   ① 真读会话存档并输出稳定 seq 的条目（TSV 与 --json 两种形态）；
 *   ② --kind / --limit 过滤；
 *   ③ 用法错误（缺 --session / 未知子动作）退出码 2；会话不存在退出码 1 且错误如实打到 stderr。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceCommand } from '../../src/cli/traceCommand.js';
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

test('trace read：缺省存储目录为工作区下 .omniharness/sessions（与存储层缺省一致）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omni-trace-cli-default-'));
  const defaultDir = join(root, '.omniharness', 'sessions');
  await mkdir(defaultDir, { recursive: true });
  const events: readonly SessionEvent[] = [
    ev('user', { content: '默认目录' }, '2026-09-19T11:00:00.000Z'),
  ];
  await writeFile(
    join(defaultDir, 's-default.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
    'utf8',
  );
  const out: string[] = [];
  const command = new TraceCommand({ write: (text) => out.push(text), workspace: root });
  const code = await command.run(['read', '--session', 's-default']);
  assert.strictEqual(code, 0);
  assert.match(out.join(''), /session\ts-default\t1 条/);
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
