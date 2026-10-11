// 判据：JsonlWriter（事件流 JSONL 落盘 / stdout）的写出契约。
//
// 覆盖的风险面：逐行 JSON、追加语义、空数组、需要转义的内容（换行/引号/反斜杠）、
// 序列化失败与真实 IO 失败时的行为（如实断言，不吞错）。
//
// 纪律：
//  - 文件路径全部走**真实文件 IO**（mkdtempSync 临时目录 + rmSync 清理），不 mock appendFile；
//  - stdout 分支只临时替换 `process.stdout.write` 做捕获，**在同一个同步块内恢复**（不跨 await），
//    避免污染 node:test 的报告输出；
//  - 每条判据旁标注「正对照」：说明改坏被测逻辑后它会在哪一步变红（另附实跑的红/绿证据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWriter } from '../../src/output/jsonlWriter.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * 造一条会话事件（字段固定，便于逐字节比对）。
 * @param id 事件 id
 * @param payload 事件载荷
 * @returns 会话事件
 */
function eventOf(id: string, payload: unknown): SessionEvent {
  return { id, type: 'user', sessionId: 'sess-1', timestamp: '2026-10-11T00:00:00.000Z', payload };
}

/**
 * 在一次性临时目录里跑用例，结束即删。
 * @param fn 用例体（接收临时目录绝对路径）
 * @returns 用例体返回值
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-jsonl-writer-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('JsonlWriter：未指定 target ⇒ 写 stdout 一行 `<json>\\n`，且不碰文件系统', async () => {
  await withTempDir(async (dir) => {
    const writer = new JsonlWriter();
    const event = eventOf('e1', { text: '甲' });
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    // stdout 分支内部无 await ⇒ 副作用在**同步**调用期完成，故可立刻恢复原函数（不跨 await）。
    const pending = writer.write(event);
    process.stdout.write = original;
    await pending;
    // 正对照：若 write 在 target 缺省时什么都不做（或改成写文件），chunks 长度会不等于 1。
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0], `${JSON.stringify(event)}\n`);
    assert.deepStrictEqual(readdirSync(dir), [], 'stdout 模式不得落任何文件');
  });
});

test('JsonlWriter：指定 target ⇒ 每条一行 JSON（行数 = 事件数，逐行解析后逐字等值）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    const writer = new JsonlWriter(file);
    const events = [
      eventOf('e1', { text: '甲', nested: { n: 1 } }),
      eventOf('e2', [1, 2, 3]),
      eventOf('e3', null),
    ];
    await writer.writeAll(events);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    assert.strictEqual(lines.length, events.length + 1, '每条一行且文件以换行结束');
    assert.strictEqual(lines[lines.length - 1], '');
    // 正对照：若 write 退化成 `${event}` 之类的裸拼接，这里 JSON.parse 会因 "[object Object]" 抛错。
    assert.deepStrictEqual(
      lines.slice(0, events.length).map((line) => JSON.parse(line)),
      events,
    );
    assert.strictEqual(lines[0], JSON.stringify(events[0]), '首行必须与 JSON.stringify 逐字节相同');
  });
});

test('JsonlWriter：追加语义（既有内容与既有行都不被覆盖）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, 'PRE-EXISTING\n', 'utf8');
    const writer = new JsonlWriter(file);
    await writer.write(eventOf('e1', 1));
    await writer.write(eventOf('e2', 2));
    const lines = readFileSync(file, 'utf8').split('\n');
    // 正对照：若 appendFile 被换成 writeFile（覆盖写），首行 PRE-EXISTING 与 e1 会一起消失。
    assert.strictEqual(lines[0], 'PRE-EXISTING');
    assert.deepStrictEqual(
      lines.slice(1, 3).map((line) => JSON.parse(line)),
      [eventOf('e1', 1), eventOf('e2', 2)],
      '追加顺序必须与调用顺序一致',
    );
    assert.strictEqual(lines.length, 4);
  });
});

test('JsonlWriter：writeAll([]) 不抛错且不创建文件（空输入零副作用）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    await new JsonlWriter(file).writeAll([]);
    // 正对照：若 writeAll 退化成「先建空文件再逐条写」（典型错误实现），existsSync 会为 true。
    assert.strictEqual(existsSync(file), false);
    assert.deepStrictEqual(readdirSync(dir), []);
  });
});

test('JsonlWriter：换行/引号/反斜杠/制表/非 ASCII 必须被转义，读回逐字等值', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    const payload = { text: '甲\n乙"丙"\\丁\t戊', looksLikeJson: '{"a":1}', emoji: '🚀' };
    const event = eventOf('e-nl', payload);
    await new JsonlWriter(file).write(event);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    assert.strictEqual(lines.length, 2, '载荷里的换行必须被转义，不能变成物理换行');
    assert.deepStrictEqual(JSON.parse(lines[0] ?? ''), event);
    // 正对照（显式复现错误实现）：朴素模板拼接**确实**会把同一载荷写成物理换行；
    // 真实实现必须不产生它 —— 这两条互相排斥，实现一旦退化成不转义的拼接就变红。
    const naive = `{"payload":${payload.text}}`;
    assert.ok(naive.includes('\n乙'), '正对照：朴素拼接会产生未转义换行');
    assert.ok(!text.includes('\n乙'), '真实实现必须把换行转义掉');
    assert.ok(!text.includes('\t'), '真实实现不得落未转义的制表符');
  });
});

test('JsonlWriter：序列化失败（BigInt 载荷）⇒ 抛 TypeError 且不落半行，已写行保持完好', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    const writer = new JsonlWriter(file);
    const bad = eventOf('e-big', 10n); // JSON.stringify 对 BigInt 抛 TypeError（真实失败，非 mock）
    await assert.rejects(writer.write(bad), TypeError);
    assert.strictEqual(existsSync(file), false, '失败不得留下空文件或半行');
    await writer.write(eventOf('e-ok', 'ok'));
    await assert.rejects(writer.write(bad), TypeError);
    const lines = readFileSync(file, 'utf8').split('\n');
    // 正对照：若 write 忽略 serialization 异常（或把 undefined 写成一行），行数会变成 3。
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(JSON.parse(lines[0] ?? ''), eventOf('e-ok', 'ok'));
    // writeAll 无事务性（如实断言）：第 1 条已落盘、第 2 条失败后整体 reject、第 3 条不再写。
    const batch = join(dir, 'batch.jsonl');
    await assert.rejects(
      new JsonlWriter(batch).writeAll([eventOf('b1', 1), bad, eventOf('b3', 3)]),
      TypeError,
    );
    const batchLines = readFileSync(batch, 'utf8').trimEnd().split('\n');
    assert.deepStrictEqual(
      batchLines.map((line) => JSON.parse(line)),
      [eventOf('b1', 1)],
      '批量写没有回滚：已写的保留，失败之后的丢弃',
    );
  });
});

test('JsonlWriter：目标目录不存在 ⇒ 真实 ENOENT 上抛，且不静默补建父目录', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'no-such-dir', 'events.jsonl');
    const writer = new JsonlWriter(file);
    await assert.rejects(
      writer.write(eventOf('e1', 1)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    // 正对照：若 write 里加了 mkdir（"顺手补目录"型实现），本断言立刻变红 ——
    // 这是与 QuotaStore 的**真实差异**：写出器不负责建目录。
    assert.strictEqual(existsSync(join(dir, 'no-such-dir')), false, '不得静默补建父目录');
    await assert.rejects(
      writer.writeAll([eventOf('e1', 1)]),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  });
});

test('JsonlWriter：target 指向目录 ⇒ 真实 EISDIR 上抛（不吞错）', async () => {
  await withTempDir(async (dir) => {
    const asDir = join(dir, 'as-dir');
    mkdirSync(asDir);
    // 正对照：若 write 用 try/catch 吞掉 appendFile 的失败（"写不了就算了"型实现），
    // assert.rejects 立刻变红。
    await assert.rejects(
      new JsonlWriter(asDir).write(eventOf('e1', 1)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EISDIR',
    );
  });
});

test('JsonlWriter：payload 为 undefined ⇒ 落盘行里该键消失（现状如实断言，读回者不可恢复）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    await new JsonlWriter(file).write({
      id: 'e-u',
      type: 'user',
      sessionId: 'sess-1',
      timestamp: '2026-10-11T00:00:00.000Z',
      payload: undefined,
    });
    const parsed = JSON.parse(readFileSync(file, 'utf8').trimEnd()) as Record<string, unknown>;
    // 正对照：显式复现 JSON.stringify 对 undefined 值的语义 —— 这正是"丢键"的来源。
    assert.strictEqual(JSON.stringify({ payload: undefined }), '{}');
    assert.ok(!('payload' in parsed), 'undefined 载荷在 JSONL 里不可恢复');
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['id', 'sessionId', 'timestamp', 'type']);
  });
});

test('JsonlWriter：非对象输入不被校验，落盘为不可解析的字面量行（现状锁定，若加校验须同步改此条）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'events.jsonl');
    await new JsonlWriter(file).write(undefined as unknown as SessionEvent);
    const line = readFileSync(file, 'utf8').trimEnd();
    assert.strictEqual(line, 'undefined', '现状：JSON.stringify(undefined) 的结果被原样落盘');
    // 正对照：证明这一行**不是**合法 JSON —— 即当前实现不校验入参，坏行会直接进日志。
    assert.throws(() => JSON.parse(line), SyntaxError);
  });
});
