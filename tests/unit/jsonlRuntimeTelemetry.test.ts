import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlRuntimeTelemetry } from '../../src/adapters/telemetry/jsonlRuntimeTelemetry.js';
import type { RuntimeObservation } from '../../src/ports/runtime/runtimeTelemetry.js';

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-'));
  return join(dir, name);
}

function obs(
  over: Partial<RuntimeObservation> = {},
): Omit<RuntimeObservation, 'seq' | 'prev' | 'hash'> {
  return {
    id: over.id ?? 'o1',
    ts: over.ts ?? '2026-09-03T00:00:00.000Z',
    kind: over.kind ?? 'cycle',
    operator: over.operator ?? 'spark-controller',
    configSnapshot: over.configSnapshot ?? { autoRun: true },
    metrics: over.metrics ?? { ran: 1 },
    verdict: over.verdict ?? 'pass',
    provenance: over.provenance ?? 'production',
  };
}

test('record 写入哈希链且 verify 通过', () => {
  const path = tmpFile('a.log');
  const sink = new JsonlRuntimeTelemetry({ path });
  const s1 = sink.record(obs({ id: 'a', operator: 'confinement' }));
  const s2 = sink.record(obs({ id: 'b', operator: 'oobleck' }));
  assert.strictEqual(s1, 1);
  assert.strictEqual(s2, 2);
  const chain = sink.verify();
  assert.strictEqual(chain.ok, true);
  assert.strictEqual(chain.count, 2);
});

test('读回观测 seq/prev/hash 完整', () => {
  const path = tmpFile('b.log');
  const sink = new JsonlRuntimeTelemetry({ path });
  sink.record(obs({ id: 'x' }));
  sink.record(obs({ id: 'y' }));
  const all = sink.read();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0]?.seq, 1);
  assert.strictEqual(all[1]?.seq, 2);
  assert.ok(typeof all[0]?.hash === 'string' && all[0]!.hash!.length === 64);
  assert.strictEqual(all[0]?.prev, '0'.repeat(64));
  assert.strictEqual(all[1]?.prev, all[0]?.hash);
});

test('改内容 → verify 检出篡改 (ok=false)', () => {
  const path = tmpFile('c.log');
  const sink = new JsonlRuntimeTelemetry({ path });
  sink.record(obs({ id: 'a' }));
  sink.record(obs({ id: 'b' }));
  sink.record(obs({ id: 'c' }));
  // 直接改中间一行的 hash 字段（模拟篡改）
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const mid = JSON.parse(lines[1]!);
  mid.hash = '0'.repeat(64);
  lines[1] = JSON.stringify(mid);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  const chain = new JsonlRuntimeTelemetry({ path }).verify();
  assert.strictEqual(chain.ok, false);
  assert.strictEqual(chain.brokenAt, 2);
});

test('坏行跳过（fail-closed 不中断读取）', () => {
  const path = tmpFile('d.log');
  const sink = new JsonlRuntimeTelemetry({ path });
  sink.record(obs({ id: 'a' }));
  appendFileSync(path, 'not-json\n');
  const reread = new JsonlRuntimeTelemetry({ path }).read();
  assert.strictEqual(reread.length, 1);
  const chain = new JsonlRuntimeTelemetry({ path }).verify();
  assert.strictEqual(chain.ok, true);
});

test('未配置目标 → no-op：record 返 undefined，read=[]，verify ok=true', () => {
  const sink = new JsonlRuntimeTelemetry({});
  assert.strictEqual(sink.record(obs()), undefined);
  assert.deepStrictEqual([...sink.read()], []);
  assert.strictEqual(sink.verify().ok, true);
});

test('跨进程重启续链（构造时从末尾恢复 seq/prev）', () => {
  const path = tmpFile('e.log');
  const s1 = new JsonlRuntimeTelemetry({ path });
  s1.record(obs({ id: 'a' }));
  s1.record(obs({ id: 'b' }));
  // 新实例应续链而非另起
  const s2 = new JsonlRuntimeTelemetry({ path });
  const s3 = s2.record(obs({ id: 'c' }));
  assert.strictEqual(s3, 3);
  assert.strictEqual(s2.verify().ok, true);
});

test('provenance 字段落盘且可被区分（收紧算法据此只认 production）', () => {
  const path = tmpFile('f.log');
  const sink = new JsonlRuntimeTelemetry({ path });
  sink.record(obs({ id: 'seed', provenance: 'seed-bootstrap', operator: 'confinement' }));
  sink.record(obs({ id: 'prod', provenance: 'production', operator: 'confinement' }));
  const all = sink.read();
  const prod = all.filter((o) => o.provenance === 'production');
  const seed = all.filter((o) => o.provenance === 'seed-bootstrap');
  assert.strictEqual(prod.length, 1);
  assert.strictEqual(seed.length, 1);
});
