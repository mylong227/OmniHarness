import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpillPort, SpillHandle } from '../../src/ports/memory/spill.js';
import { VortexRingPacket } from '../../src/adapters/spill/vortexRingSpillAdapter.js';

/** 测试用内存 Spill 桩。 */
class MemSpill implements SpillPort {
  public readonly name = 'mem-spill';
  private store = new Map<string, string>();
  private n = 0;
  public async spill(content: string): Promise<SpillHandle> {
    const id = `sp_${this.n++}`;
    this.store.set(id, content);
    return { id, bytes: Buffer.byteLength(content, 'utf8') };
  }
  public async read(id: string): Promise<string | undefined> {
    return this.store.get(id);
  }
  /** 测试专用：篡改后端内容（模拟传输中被替换）。 */
  public corrupt(id: string, content: string): void {
    this.store.set(id, content);
  }
}

const BIG = 'x'.repeat(4096); // 4KB 内容，验证环包不随内容膨胀。

test('封环/解环：紧凑 token 不含原文，解环还原完整保真', async () => {
  const vr = new VortexRingPacket(new MemSpill());
  const ring = await vr.seal('拓扑孤子穿越上下文而不耗散');
  assert.ok(!ring.token.includes('拓扑孤子'), '传输 token 不应含原文');
  assert.ok(ring.token.length < 64, `token 应紧凑，实得 ${ring.token.length} 字节`);
  const back = await vr.unseal(ring);
  assert.strictEqual(back, '拓扑孤子穿越上下文而不耗散');
});

test('不扩散：内容越大，环包 token 长度恒定（长程传输不被稀释）', async () => {
  const vr = new VortexRingPacket(new MemSpill());
  const small = await vr.seal('短');
  const large = await vr.seal(BIG);
  assert.strictEqual(small.token.length, large.token.length, 'token 长度应恒定，不随内容膨胀');
  assert.ok(large.token.length < BIG.length / 10, 'token 远小于原文');
  assert.strictEqual(await vr.unseal(large), BIG, '大内容解环仍完整');
});

test('fail-closed 抗污染：后端内容被篡改 → 解环拒绝还原', async () => {
  const spill = new MemSpill();
  const vr = new VortexRingPacket(spill);
  const ring = await vr.seal('原始思维链');
  spill.corrupt(ring.spill.id, '被注入的恶意内容');
  const back = await vr.unseal(ring);
  assert.strictEqual(back, undefined, '内容校验和不匹配应拒绝');
});

test('fail-closed 抗篡改：环包拓扑荷被改 → 解环拒绝还原', async () => {
  const vr = new VortexRingPacket(new MemSpill());
  const ring = await vr.seal('原始思维链');
  const tampered = { ...ring, winding: ring.winding + 1 };
  const back = await vr.unseal(tampered);
  assert.strictEqual(back, undefined, '拓扑荷不一致应拒绝');
});

test('拓扑守恒：相同内容 → 固化拓扑荷/校验和确定性一致', async () => {
  const vr = new VortexRingPacket(new MemSpill());
  const a = await vr.seal('同一段思维');
  const b = await vr.seal('同一段思维');
  assert.strictEqual(a.winding, b.winding, '相同内容拓扑荷应守恒');
  assert.strictEqual(a.checksum, b.checksum, '相同内容校验和应一致');
});
