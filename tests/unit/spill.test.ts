import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpillPolicy } from '../../src/context/spillPolicy.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { FileSpill } from '../../src/adapters/spill/fileSpill.js';
import { SpillReadTool } from '../../src/adapters/tool/spillReadTool.js';
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
