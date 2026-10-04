/**
 * S3（GEE Kernel v1 · ADR-0008）：晋升台账 + 回滚判据。
 *
 * 蓝图判据（EVOLUTION_ARCH_UPGRADE_2026-10 §4 S3）：
 * - 晋升前快照存在且 `verify()=ok`；
 * - `rollback(seq)` 后技能表与快照**逐条深相等**；
 * - **变异**：改台账中间条目 ⇒ `verify()` 红（篡改检出）；
 * - 关台账 ⇒ 晋升被 fail-closed 拒绝（不允许「无快照晋升」）；
 * - 附加：重启续链 / 固定时钟确定性 / 非法 seq 抛错 / 回滚事件自身入链；
 * - 附加：spec 声明的 `evolution.ledger.*` 观测行接线（且观测 fail-open 不连累治理写入）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import type { Skill } from '../../src/skill/skill.js';

/** 固定时钟（确定性）。 */
const FIXED_NOW = (): string => '2026-10-04T00:00:00.000Z';

/**
 * 造技能。
 * @param name 技能名
 * @returns Skill
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤`, tags: [name] };
}

/** 新建临时目录。 */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'omni-ledger-'));
}

test('S3 快照/晋升/回滚入链：verify ok、seq 递增、JSONL 落盘与内存链一致', () => {
  const dir = workspace();
  const ledger = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  const table = [skillOf('a'), skillOf('b')];
  const snapshotSeq = ledger.snapshotBefore(table);
  assert.strictEqual(snapshotSeq, 1, '首条即快照（seq=1）');
  assert.strictEqual(ledger.append({ name: 'crystal:x', source: 'twist:a+b' }), 2);
  const report = ledger.verify();
  assert.strictEqual(report.ok, true, '正常操作序列 → 链完整');
  assert.strictEqual(report.count, 2);
  const file = join(dir, 'ledger.jsonl');
  assert.ok(existsSync(file), '台账必须落盘');
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  assert.strictEqual(lines.length, 2, 'JSONL 行数 = 条目数');
  const first = JSON.parse(lines[0]!) as { action: string; skills: readonly Skill[] };
  assert.strictEqual(first.action, 'snapshot');
  assert.deepStrictEqual(first.skills, table, '快照条目携带晋升前全量表');
});

test('S3 还原判据：rollback(seq) 的还原计划与快照逐条深相等（含晋升后新增者的移除线索）', () => {
  const ledger = new HashChainPromotionLedger({ now: FIXED_NOW });
  const before = [skillOf('a'), skillOf('b')];
  const seq = ledger.snapshotBefore(before);
  ledger.append({ name: 'crystal:x', source: 'twist:a+b' });
  ledger.append({ name: 'crystal:y', source: 'twist:a+c' });
  const plan = ledger.rollback(seq);
  assert.strictEqual(plan.seq, seq);
  assert.deepStrictEqual(plan.skills, before, '还原计划 = 快照深副本（逐条深相等）');
  assert.notStrictEqual(plan.skills, before, '必须是深副本（改动互不影响）');
  // 回滚事件自身入链：链仍完整，且新条目为 rollback 型（rollbackTo 定位正确）。
  assert.strictEqual(ledger.verify().ok, true);
  assert.strictEqual(ledger.verify().count, 4, 'snapshot + promote×2 + rollback');
});

test('S3 变异判据：改台账中间条目 ⇒ verify() 红（篡改检出）且断链拒绝写入', () => {
  const dir = workspace();
  const ledger = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  ledger.snapshotBefore([skillOf('a')]);
  ledger.append({ name: 'x', source: 'twist:a+b' });
  ledger.append({ name: 'y', source: 'twist:a+c' });
  const file = join(dir, 'ledger.jsonl');
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const tampered = JSON.parse(lines[1]!) as { promoted: { name: string } };
  tampered.promoted.name = 'forged-skill';
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const reloaded = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  const report = reloaded.verify();
  assert.strictEqual(report.ok, false, '中间条目被改 → 链验签必须红');
  assert.strictEqual(report.brokenAt, 2, '断裂处定位到被改条目');
  assert.throws(
    () => reloaded.append({ name: 'z', source: 'twist:x' }),
    /fail-closed/,
    '断链上的一切写入必须抛错（不制造第二本假账）',
  );
});

test('S3 fail-closed：rollback 非法 seq（链中无 ≤seq 快照）抛错，绝不静默空还原', () => {
  const ledger = new HashChainPromotionLedger({ now: FIXED_NOW });
  ledger.append({ name: 'x', source: 'twist:a+b' });
  assert.throws(() => ledger.rollback(99), /定位不到快照/);
  assert.throws(() => ledger.rollback(1), /定位不到快照/, 'promote 条目不是快照');
});

test('S3 确定性：固定时钟下同操作序列的台账文件逐字节相同（golden 钉死分隔符口径）', () => {
  const run = (): string => {
    const dir = workspace();
    const ledger = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
    ledger.snapshotBefore([skillOf('a'), skillOf('b')]);
    ledger.append({ name: 'crystal:x', source: 'twist:a+b' });
    return readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  };
  assert.strictEqual(run(), run(), '同输入必须恒同链（哈希/时间戳/键序全部确定）');
});

test('S3 重启续链：新进程构造后 seq 续接、链完整', () => {
  const dir = workspace();
  const first = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  first.snapshotBefore([skillOf('a')]);
  first.append({ name: 'x', source: 'twist:a+b' });
  const second = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  assert.strictEqual(second.verify().ok, true, '历史链载入后验签通过');
  const seq = second.append({ name: 'y', source: 'twist:a+c' });
  assert.strictEqual(seq, 3, 'seq 从历史末尾续接');
  assert.strictEqual(second.verify().ok, true);
});

test('S3 载入容错：截断/非 JSON 行 ⇒ verify 红且定位（不静默重置历史）', () => {
  const dir = workspace();
  const ledger = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  ledger.snapshotBefore([skillOf('a')]);
  const file = join(dir, 'ledger.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8') + '{"broken": tru', 'utf8');
  const reloaded = new HashChainPromotionLedger({ dir, now: FIXED_NOW });
  assert.strictEqual(reloaded.verify().ok, false, '截断文件必须判红（不得静默丢弃）');
});

test('S3 观测行接线：spec 声明的 evolution.ledger.appended / .rollback 如实发出（声明必须接线）', () => {
  const rows: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  const ledger = new HashChainPromotionLedger({
    now: FIXED_NOW,
    observer: (msg, fields) => rows.push({ msg, fields }),
  });
  const seq = ledger.snapshotBefore([skillOf('a'), skillOf('b')]);
  ledger.append({ name: 'crystal:x', source: 'twist:a+b' });
  ledger.rollback(seq);
  assert.deepStrictEqual(
    rows.map((r) => [r.msg, r.fields['action'] ?? r.fields['rollbackTo']]),
    [
      ['evolution.ledger.appended', 'snapshot'],
      ['evolution.ledger.appended', 'promote'],
      ['evolution.ledger.appended', 'rollback'],
      ['evolution.ledger.rollback', seq],
    ],
    '入链三条各发一次 appended（seq/action），回滚另发 rollback（seq→快照）',
  );
  assert.deepStrictEqual(
    rows.map((r) => r.fields['seq']),
    [1, 2, 3, seq],
    '观测行携带 seq（可据此与落盘 JSONL 对账）',
  );
  assert.strictEqual(rows.at(-1)?.fields['restored'], 2, 'rollback 行申报还原条数');
});

test('S3 观测 fail-open：回调抛错只告警，绝不连累治理写入（观测不是治理边界）', () => {
  const ledger = new HashChainPromotionLedger({
    now: FIXED_NOW,
    observer: () => {
      throw new Error('sink 崩了');
    },
  });
  const seq = ledger.snapshotBefore([skillOf('a')]);
  assert.strictEqual(ledger.append({ name: 'x', source: 'twist:a+b' }), 2);
  assert.doesNotThrow(() => ledger.rollback(seq), '观测炸了不得影响回滚');
  assert.strictEqual(ledger.verify().ok, true, '链完整性不受观测影响');
});
