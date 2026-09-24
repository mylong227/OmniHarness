/**
 * 哈希链 golden 回归（审计 §3.5：审计链与遥测链「同构且已语义分叉」的收口）。
 *
 * 两条链（`server/services/auditSink.ts` / `adapters/telemetry/jsonlRuntimeTelemetry.ts`）
 * 的**算法**现已共享（`util/hashChain.ts`），但**分隔符历史上就不同**（审计链 NUL、遥测链空格），
 * 而改分隔符＝改历史哈希 ⇒ 已落盘的链当场验签失败。故本测试用**固定输入 + 固定哈希**把
 * 「两侧的字节级行为」钉死：任何人不小心统一分隔符、调整正文键序、或改动 GENESIS，都会在这里变红。
 *
 * 另附一条**事故回归**：审计链的分隔符曾在源码里写成**裸 NUL 字节**（而非转义序列），
 * 导致该文件被工具链当作二进制（`read` 直接拒读、diff/编辑器失效）。这里扫描源码确认
 * `src/**` 不含裸 NUL。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HashChain } from '../../src/util/hashChain.js';
import { AuditSink } from '../../src/server/services/auditSink.js';
import { JsonlRuntimeTelemetry } from '../../src/adapters/telemetry/jsonlRuntimeTelemetry.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 审计链 golden（由重构前的实现取得，重构后必须逐字节一致）。 */
const AUDIT_GOLDEN = 'd9d430bc3caf97b3716d9ca404e86ba982aea32ec6047f42ec58ff06fb758615';

/** 遥测链 golden（同上）。 */
const TELEMETRY_GOLDEN = '03672d515436729c574010ef6a54f96d74a2efc11ba4925c2665b9d918d0432c';

/** 固定时间戳（避免用当前时间导致 golden 不稳）。 */
const TS = '2026-09-24T00:00:00.000Z';

test('审计链 golden：固定输入 ⇒ 固定哈希（分隔符/正文/创世哈希任一改动即红）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-chain-audit-'));
  try {
    const path = join(dir, 'audit.jsonl');
    const sink = new AuditSink({ path });
    sink.record({
      ts: TS,
      type: 'test.event',
      sessionId: 's-1',
      actor: 'tester',
      detail: { b: 2, a: 1 },
    });
    const line = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0] ?? '{}') as {
      hash?: string;
      prev?: string;
    };
    assert.strictEqual(line.prev, HashChain.GENESIS);
    assert.strictEqual(
      line.hash,
      AUDIT_GOLDEN,
      '审计链哈希变了 ⇒ 已落盘的审计日志会验签失败；若非**刻意**变更，请回退分隔符/正文改动',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('遥测链 golden：固定输入 ⇒ 固定哈希（与审计链同算法、不同分隔符）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-chain-telemetry-'));
  try {
    const path = join(dir, 'telemetry.jsonl');
    const telemetry = new JsonlRuntimeTelemetry({ path });
    telemetry.record({
      id: 'e-1',
      ts: TS,
      kind: 'cycle',
      operator: 'op',
      configSnapshot: { x: 1 },
      metrics: { n: 2 },
      verdict: 'pass',
      provenance: 'production',
    });
    const line = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0] ?? '{}') as {
      hash?: string;
      prev?: string;
    };
    assert.strictEqual(line.prev, HashChain.GENESIS);
    assert.strictEqual(line.hash, TELEMETRY_GOLDEN, '遥测链哈希变了 ⇒ 已落盘遥测会验签失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('共享算法：与「直接 SHA256(prev ‖ sep ‖ canonical)」等价，且分隔符确实影响结果', () => {
  const prev = HashChain.GENESIS;
  const canonical = '{"seq":1}';
  // 与手写实现逐字节等价（共享算法不得引入任何附加处理）
  assert.strictEqual(
    HashChain.hash(prev, canonical, '\u0000'),
    createHash('sha256').update(prev).update('\u0000').update(canonical).digest('hex'),
  );
  // 分隔符不同 ⇒ 哈希不同（这正是两条链不能统一分隔符的原因）
  assert.notStrictEqual(
    HashChain.hash(prev, canonical, '\u0000'),
    HashChain.hash(prev, canonical, ' '),
  );
  // 创世哈希：全零 64 hex（非空串——空串与「缺 prev」不可区分）
  assert.strictEqual(HashChain.GENESIS, '0'.repeat(64));
  assert.strictEqual(HashChain.GENESIS.length, 64);
});

test('事故回归：src/** 不含裸 NUL 字节（否则文件被当二进制，diff/检索/编辑全失效）', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|json)$/.test(name)) continue;
      const bytes = readFileSync(full);
      if (bytes.includes(0)) offenders.push(relative(repoRoot, full).split(sep).join('/'));
    }
  };
  walk(join(repoRoot, 'src'));
  walk(join(repoRoot, 'defaults'));
  assert.deepStrictEqual(offenders, [], `源码/数据文件含裸 NUL 字节：${offenders.join(', ')}`);
});
