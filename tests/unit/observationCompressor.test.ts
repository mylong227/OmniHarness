import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ObservationCompressor } from '../../src/context/observationCompressor.ts';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.ts';
import type { SpillHandle, SpillPort } from '../../src/ports/memory/spill.ts';

/** 内存外溢端口（记录全文，验证“压缩只影响预览”）。 */
class MemorySpill implements SpillPort {
  public readonly name = 'memory';
  public saved = '';
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    this.saved = content;
    return { id: 'spill_1', bytes: Buffer.byteLength(content, 'utf8') };
  }
  public async read(_id: string): Promise<string | undefined> {
    return this.saved;
  }
}

/** 造 100 行输出，第 50 行是断言失败。 */
function longOutput(): string {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${String(index + 1)}`);
  lines[49] = 'AssertionError: expected 1 to equal 2';
  return `\u001B[31m${lines.join('\n')}\u001B[0m`;
}

test('观测压缩：错误行优先保留，ANSI 剥离，超长有省略标记', () => {
  const preview = ObservationCompressor.preview(longOutput(), { maxLines: 20, maxChars: 5_000 });
  assert.match(preview, /AssertionError/u);
  assert.match(preview, /省略 \d+ 行/u);
  assert.doesNotMatch(preview, /\u001B\[/u);
  assert.ok(preview.length <= 5_000 + 40, `预览应受字符预算约束，实际 ${String(preview.length)}`);
});

test('观测压缩：短输出原样（只剥 ANSI），不加省略标记', () => {
  assert.strictEqual(ObservationCompressor.preview('\u001B[32mok\u001B[0m'), 'ok');
});

test('外溢预览：shell 长输出保留错误行，完整内容仍落外溢', async () => {
  const spill = new MemorySpill();
  const spiller = new ToolResultSpiller(spill, { maxInlineBytes: 10, previewBytes: 2_000 });
  const content = longOutput();
  const result = await spiller.apply('shell', { callId: 'c1', ok: false, error: content }, 's1');
  assert.match(result.error ?? '', /AssertionError/u);
  assert.match(result.error ?? '', /spill:\/\/spill_1/u);
  assert.strictEqual(spill.saved, content, '外溢必须保存全文，而不是压缩后的预览');
});
