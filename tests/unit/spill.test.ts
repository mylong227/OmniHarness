import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpillPolicy } from '../../src/context/spillPolicy.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { FileSpill } from '../../src/adapters/spill/fileSpill.js';
import {
  VortexRingPacket,
  VortexRingSpillAdapter,
} from '../../src/adapters/spill/vortexRingSpillAdapter.js';
import { SpillReadTool } from '../../src/adapters/tool/meta/spillReadTool.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import type { ToolResult } from '../../src/ports/tool/tool.js';

/** 构造成功的大输出工具结果。 */
function bigResult(output: string, callId = 'c1'): ToolResult {
  return { callId, ok: true, output };
}

/** 从外溢提示文本中提取外溢 id。 */
function spillIdOf(text: string): string {
  const matched = /spill:\/\/([A-Za-z0-9_-]+)/.exec(text);
  if (matched === null || matched[1] === undefined) {
    throw new Error(`未找到外溢 id: ${text.slice(0, 120)}`);
  }
  return matched[1];
}

test('外溢策略：未超阈值不外溢，空内容不外溢', () => {
  const policy = new SpillPolicy({ maxInlineBytes: 1000, previewBytes: 100 });
  assert.strictEqual(policy.needsSpill('x'.repeat(1000)), false);
  assert.strictEqual(policy.needsSpill('x'.repeat(1001)), true);
  assert.strictEqual(policy.needsSpill(undefined), false);
});

test('外溢策略：预览按字节截断，短内容原样返回', () => {
  const policy = new SpillPolicy({ maxInlineBytes: 10, previewBytes: 5 });
  assert.strictEqual(policy.preview('abc'), 'abc');
  assert.strictEqual(policy.preview('abcdefghij'), 'abcde');
});

// ---- 2026-09-22 回归（审计 P3）：previewBytes 是**字节**预算，不能按 UTF-16 码元切 ----
test('外溢策略：CJK / emoji 预览严格不超字节预算，且不切出半个字符', () => {
  const policy = new SpillPolicy({ maxInlineBytes: 10, previewBytes: 8 });
  // 中文：每字 3 字节 ⇒ 8 字节只能放 2 个字（旧实现会放 8 个字 = 24 字节，超 3 倍）
  const cjk = '中文测试内容超长'.repeat(3);
  const p1 = policy.preview(cjk);
  assert.ok(Buffer.byteLength(p1, 'utf8') <= 8, `中文预览超预算：${Buffer.byteLength(p1, 'utf8')}`);
  assert.strictEqual(p1, '中文');
  // emoji（4 字节代理对）：7 字节预算下只能放 1 个（旧实现按码元切会把代理对切成半个）
  const p2 = new SpillPolicy({ maxInlineBytes: 4, previewBytes: 7 }).preview('🙂🙂🙂');
  assert.ok(
    Buffer.byteLength(p2, 'utf8') <= 7,
    `emoji 预览超预算：${Buffer.byteLength(p2, 'utf8')}`,
  );
  assert.strictEqual(p2, '🙂', '不得产出半个代理对/半个 UTF-8 序列');
  // 预算恰好等于整串字节 ⇒ 原样返回
  assert.strictEqual(policy.preview('中文'), '中文');
});

test('内存外溢端口：写入后可原样读回', async () => {
  const port = new MemorySpill();
  const handle = await port.spill('完整内容', 'sess_1');
  assert.strictEqual(handle.bytes, Buffer.byteLength('完整内容', 'utf8'));
  assert.strictEqual(await port.read(handle.id), '完整内容');
  assert.strictEqual(await port.read('spill_不存在_9'), undefined);
});

test('文件外溢端口：跨实例可读回，非法 id 返回 undefined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-spill-'));
  try {
    const writer = new FileSpill(dir);
    const handle = await writer.spill('落盘完整内容', 'sess_1');
    // 换一个实例读取，证明内容确实持久化而非留在内存
    const reader = new FileSpill(dir);
    assert.strictEqual(await reader.read(handle.id), '落盘完整内容');
    assert.strictEqual(await reader.read('spill_不存在_9'), undefined);
    // 目录穿越型 id 必须被拒绝
    assert.strictEqual(await reader.read('..\\..\\evil'), undefined);
    assert.strictEqual(await reader.read('a/b'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('外溢器：小输出原样返回不落后端', async () => {
  const port = new MemorySpill();
  const spiller = new ToolResultSpiller(port, { maxInlineBytes: 1000, previewBytes: 100 });
  const result = bigResult('短输出');
  assert.strictEqual(await spiller.apply('shell', result, 'sess_1'), result);
});

test('外溢器：大输出替换为预览 + 定位符，全文可从后端读回', async () => {
  const port = new MemorySpill();
  const spiller = new ToolResultSpiller(port, { maxInlineBytes: 1000, previewBytes: 100 });
  const content = 'A'.repeat(5000);
  const stored = await spiller.apply('read_file', bigResult(content), 'sess_1');
  const output = stored.output ?? '';
  assert.ok(output.startsWith('A'.repeat(100)), '预览应保留头部');
  assert.ok(output.includes('已省略 4900 字节'), `应报告省略量，实际: ${output.slice(-80)}`);
  assert.ok(output.includes('spill_read'));
  // 全文未丢失：按 id 可取回
  assert.strictEqual(await port.read(spillIdOf(output)), content);
});

test('外溢器：spill_read 工具豁免，避免读回时再次被截断', async () => {
  const port = new MemorySpill();
  const spiller = new ToolResultSpiller(port, { maxInlineBytes: 100, previewBytes: 10 });
  const content = 'B'.repeat(500);
  const result = bigResult(content);
  assert.strictEqual(await spiller.apply('spill_read', result, 'sess_1'), result);
  // 非豁免工具仍会外溢（对照）
  const spilled = await spiller.apply('shell', result, 'sess_1');
  assert.ok((spilled.output ?? '').includes('spill://'));
});

test('外溢器：过大的 error 字段同样外溢', async () => {
  const port = new MemorySpill();
  const spiller = new ToolResultSpiller(port, { maxInlineBytes: 100, previewBytes: 10 });
  const stored = await spiller.apply(
    'shell',
    { callId: 'c2', ok: false, error: 'E'.repeat(500) },
    'sess_1',
  );
  const error = stored.error ?? '';
  assert.ok(error.includes('spill://'));
  assert.strictEqual(await port.read(spillIdOf(error)), 'E'.repeat(500));
});

test('外溢读回工具：按 id 取回全文，缺失时报可读错误', async () => {
  const port = new MemorySpill();
  const handle = await port.spill('原文', 'sess_1');
  const tool = new SpillReadTool(port);
  const ok = await tool.handle(
    { id: 'call_1', name: 'spill_read', arguments: { id: handle.id } },
    {
      sessionId: 'sess_1',
      workspaceRoot: process.cwd(),
    },
  );
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.output, '原文');

  const missing = await tool.handle(
    { id: 'call_2', name: 'spill_read', arguments: { id: 'spill_无_1' } },
    {
      sessionId: 'sess_1',
      workspaceRoot: process.cwd(),
    },
  );
  assert.strictEqual(missing.ok, false);
  assert.ok((missing.error ?? '').includes('外溢内容不存在'));
});

test('默认配置：工具集包含 spill_read，且默认外溢后端为 file', () => {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
  });
  const names = config.tools.list().map((tool) => tool.name);
  assert.ok(names.includes('spill_read'), `默认工具集应含 spill_read，实际: ${names.join(',')}`);
  assert.strictEqual(config.spill.name, 'file');
  assert.strictEqual(typeof config.spiller.apply, 'function');
});

test('默认配置：spillAdapter=memory 时后端为内存', () => {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: new MockModel(),
    storage: new MemoryStorage(),
    spillAdapter: 'memory',
  });
  assert.strictEqual(config.spill.name, 'memory');
});

// ---- 2026-09-24（审计 §1.7「spill 产物与涡环包无回收」）----

test('文件外溢：超过保留上限即回收最旧产物（此前只写不删、无界增长）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-spill-gc-'));
  try {
    const port = new FileSpill(dir, { maxFiles: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const handle = await port.spill(`内容-${i}`, 'sess_1');
      ids.push(handle.id);
      // mtime 精度：同毫秒写入会让「最旧」不可判定，故每轮间隔一点时间
      await new Promise((r) => setTimeout(r, 12));
    }
    assert.deepStrictEqual(readdirSync(dir).sort().length, 3, '目录内应只剩上限个产物');
    // 最新的仍可读回
    assert.strictEqual(await port.read(ids[5] as string), '内容-5');
    // 最旧的已被回收 ⇒ 读回 undefined（与「不存在」同语义，fail-closed）
    assert.strictEqual(await port.read(ids[0] as string), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件外溢：maxFiles=0 表示不回收（显式保留旧行为）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-spill-nogc-'));
  try {
    const port = new FileSpill(dir, { maxFiles: 0 });
    for (let i = 0; i < 4; i += 1) {
      await port.spill(`内容-${i}`, 'sess_1');
    }
    assert.strictEqual(readdirSync(dir).length, 4);
    assert.strictEqual(await port.collect(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件外溢：上限进配置（spillMaxFiles 生效，默认 512）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-spill-cfg-'));
  try {
    const config = ConfigFactory.build({
      workspaceRoot: dir,
      maxSteps: 4,
      model: new MockModel(),
      storage: new MemoryStorage(),
      spillDir: 'spill',
      spillMaxFiles: 2,
    });
    for (let i = 0; i < 4; i += 1) {
      await config.spill.spill(`内容-${i}`, 'sess_1');
      await new Promise((r) => setTimeout(r, 12));
    }
    assert.strictEqual(readdirSync(join(dir, 'spill')).length, 2, '配置的上限必须真的生效');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件外溢：回收路径的失败分支只告警不抛错（根缺失 / stat 失败 / rm 失败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-spill-err-'));
  try {
    // (a) 根目录不存在：readdir 失败 ⇒ 返回 0 且不抛错
    assert.strictEqual(await new FileSpill(join(dir, 'missing'), { maxFiles: 2 }).collect(), 0);

    const root = join(dir, 'spill');
    mkdirSync(root);
    // (b) 名为 ghost.txt 的**悬空 junction**：readdir 看得到、stat 跟随失败 ⇒ 跳过该条
    let ghost = false;
    try {
      symlinkSync(join(dir, 'nope-target'), join(root, 'ghost.txt'), 'junction');
      ghost = true;
    } catch {
      // 无权限/不支持时跳过这一子断言（其余断言仍有效）
    }
    // (c) 名为 old.txt 的**非空目录**：stat 成功、rm 失败（非递归删非空目录）⇒ 只告警
    const oldDir = join(root, 'old.txt');
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'inner.txt'), 'x');
    utimesSync(oldDir, new Date(0), new Date(0)); // 置为最旧，确保进入删除切片
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(root, `new${i}.txt`), 'x');
    }

    const removed = await new FileSpill(root, { maxFiles: 2 }).collect();
    assert.strictEqual(removed, 2, '可删的应删掉，删不掉的只跳过（不中断整体回收）');
    assert.ok(existsSync(oldDir), 'rm 失败的条目必须保留，且不得抛错');
    assert.strictEqual(existsSync(join(root, 'new0.txt')), false);
    assert.strictEqual(existsSync(join(root, 'new1.txt')), false);
    assert.strictEqual(existsSync(join(root, 'new2.txt')), true, '最新的一条应被保留');
    if (ghost) {
      // 必须用 readdir 而不是 existsSync：existsSync **跟随**链接，对悬空 junction 会返回 false，
      // 看起来像「被删了」，其实目录项还在（这正是本断言要区分的）。
      assert.ok(readdirSync(root).includes('ghost.txt'), 'stat 失败的条目未被误删（目录项仍在）');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('涡环包外溢：进程内持环数受上限约束，淘汰最久未使用者且可告警归因', async () => {
  const inner = new MemorySpill();
  const adapter = new VortexRingSpillAdapter(new VortexRingPacket(inner), { maxRings: 2 });
  const first = await adapter.spill('环-1', 'sess_1');
  const second = await adapter.spill('环-2', 'sess_1');
  await new Promise((r) => setTimeout(r, 5));
  const third = await adapter.spill('环-3', 'sess_1');

  assert.strictEqual(adapter.flush().activeRings, 2, '持环数必须被上限约束（此前只增不减）');
  assert.strictEqual(await adapter.read(third.id), '环-3');
  assert.strictEqual(await adapter.read(second.id), '环-2');
  assert.strictEqual(await adapter.read(first.id), undefined, '最久的环包应已被淘汰');

  // 命中的环包会被续命：读回 second 后再溢出一次，被淘汰的应是 third 而不是 second
  const fourth = await adapter.spill('环-4', 'sess_1');
  assert.strictEqual(adapter.flush().activeRings, 2);
  assert.strictEqual(await adapter.read(second.id), '环-2');
  assert.strictEqual(await adapter.read(third.id), undefined);
  assert.strictEqual(await adapter.read(fourth.id), '环-4');
});

test('涡环包外溢：maxRings=0 表示不淘汰', async () => {
  const adapter = new VortexRingSpillAdapter(new VortexRingPacket(new MemorySpill()), {
    maxRings: 0,
  });
  for (let i = 0; i < 5; i += 1) {
    await adapter.spill(`环-${i}`, 'sess_1');
  }
  assert.strictEqual(adapter.flush().activeRings, 5);
});
