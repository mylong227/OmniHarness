/**
 * F2（治理台数据面）判据：**每条晋升记录都能被独立复核**（数据与证据同源）。
 *
 * ## 判据要钉死什么
 *
 * 1. **逐行可核**：正常台账 ⇒ 每行 `verified:true`，且 `summary.verified === total`；
 * 2. **独立复核真的独立**（变异自证）：
 *    - **改正文**（把某行的 `promoted.name` 换掉）⇒ 该行自算哈希不符 ⇒ `verified:false` 且 `firstFailureSeq` 指向它；
 *    - **删行**（中间抽掉一条）⇒ 后续行 `prev` 接不上 ⇒ 断链被检出；
 *    - **改哈希**（把某行的 `hash` 换成别的）⇒ 自算不符 ⇒ 检出。
 *    > 这三条是"治理台能不能信"的全部意义：只把台账 `verify()` 的结论抄一遍的实现在这里会全绿——
 *    > 本判据喂的是**被篡改的条目数组**，而复核对每个条目**各自**重算，故必须红。
 * 3. **回滚入口**：快照锚点按时间倒序给出，且带 skillCount（治理台据此渲染"回滚到什么状态"）；
 * 4. **只读**：取视图不改变台账内容（`append/rollback` 计数不变）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PromotionHistoryService } from '../../src/governance/promotionHistoryService.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import type {
  PromotionLedgerEntry,
  PromotionLedgerPort,
} from '../../src/ports/runtime/evolution.js';
import type { Skill } from '../../src/ports/skill/skill.js';

/**
 * 造一条技能（快照用）。
 * @param name 技能名
 * @returns 技能
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤` };
}

/**
 * 造一份带快照与晋升的真实台账。
 * @returns 台账与服务
 */
function makeLedger(): {
  readonly ledger: HashChainPromotionLedger;
  readonly service: PromotionHistoryService;
} {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gov-'));
  const ledger = new HashChainPromotionLedger({
    dir,
    now: () => '2026-10-04T00:00:00.000Z',
  });
  ledger.snapshotBefore([skillOf('a'), skillOf('b')]);
  ledger.append({ name: 'c', source: 'twist:a+b' });
  ledger.snapshotBefore([skillOf('a'), skillOf('b'), skillOf('c')]);
  ledger.append({ name: 'd', source: 'pack:demo@pub-1' });
  return {
    ledger,
    service: new PromotionHistoryService(ledger, (entry) => HashChainPromotionLedger.hashOf(entry)),
  };
}

/**
 * 把台账包装成"条目被篡改过"的端口（**只换 list() 的返回值**，其余委托）。
 * @param ledger 真实台账
 * @param mutate 篡改函数
 * @returns 端口
 */
function tampered(
  ledger: HashChainPromotionLedger,
  mutate: (entries: readonly PromotionLedgerEntry[]) => readonly PromotionLedgerEntry[],
): PromotionLedgerPort {
  return {
    snapshotBefore: (skills) => ledger.snapshotBefore(skills),
    append: (record) => ledger.append(record),
    rollback: (seq) => ledger.rollback(seq),
    verify: () => ledger.verify(),
    list: () => mutate(ledger.list()),
  };
}

test('F2 逐行可核：正常台账每行 verified，且汇总自洽', () => {
  const { service } = makeLedger();
  const view = service.view();
  assert.strictEqual(view.rows.length, 4);
  assert.strictEqual(view.summary.total, 4);
  assert.strictEqual(view.summary.verified, 4, '正常台账必须每行通过独立复核');
  assert.strictEqual(view.summary.firstFailureSeq, undefined);
  for (const row of view.rows) {
    assert.strictEqual(row.verified, true, `第 ${String(row.seq)} 行应通过`);
    assert.strictEqual(row.reason, undefined);
  }
  // 行内容与台账一致（数据与证据同源：名字/来源直接来自台账，不二次加工）。
  const promoted = view.rows.filter((row) => row.action === 'promote');
  assert.deepStrictEqual(
    promoted.map((row) => [row.name, row.source]),
    [
      ['c', 'twist:a+b'],
      ['d', 'pack:demo@pub-1'],
    ],
  );
});

test('F2 独立复核（变异自证）：改正文 / 删行 / 改哈希 三类都必须被检出', () => {
  const { ledger } = makeLedger();

  // ① 改正文：把某条晋升记录的名字换掉（哈希不变）⇒ 自算不符。
  const bodyTampered = new PromotionHistoryService(
    tampered(ledger, (entries) =>
      entries.map((entry) =>
        entry.seq === 2 && entry.promoted !== undefined
          ? { ...entry, promoted: { name: 'evil', source: entry.promoted.source } }
          : entry,
      ),
    ),
    (entry) => HashChainPromotionLedger.hashOf(entry),
  ).view();
  assert.strictEqual(bodyTampered.summary.verified, bodyTampered.summary.total - 1, '恰好一行失败');
  assert.strictEqual(bodyTampered.summary.firstFailureSeq, 2);
  const failed = bodyTampered.rows.find((row) => row.seq === 2);
  assert.strictEqual(failed?.verified, false);
  assert.match(failed?.reason ?? '', /自算哈希与记录不符/);

  // ② 删行：抽掉中间一条 ⇒ 后续行 prev 接不上（断链）。
  const deleted = new PromotionHistoryService(
    tampered(ledger, (entries) => entries.filter((entry) => entry.seq !== 2)),
    (entry) => HashChainPromotionLedger.hashOf(entry),
  ).view();
  assert.ok(deleted.summary.verified < deleted.summary.total, '删行必须被检出（断链）');
  assert.ok(
    deleted.rows.some((row) => row.reason !== undefined && /prev 未接上上一条/.test(row.reason)),
    '断链原因必须可读',
  );

  // ③ 改哈希：把某条的 hash 换成别的 ⇒ 自算不符。
  const hashTampered = new PromotionHistoryService(
    tampered(ledger, (entries) =>
      entries.map((entry) => (entry.seq === 3 ? { ...entry, hash: 'f'.repeat(64) } : entry)),
    ),
    (entry) => HashChainPromotionLedger.hashOf(entry),
  ).view();
  assert.strictEqual(hashTampered.summary.firstFailureSeq, 3);
  assert.strictEqual(hashTampered.rows.find((row) => row.seq === 3)?.verified, false);
});

test('F2 回滚入口：快照锚点时间倒序 + 带 skillCount（治理台据此渲染回滚目标）', () => {
  const { service } = makeLedger();
  const view = service.view();
  assert.strictEqual(view.rollbackTargets.length, 2, '两个快照 ⇒ 两个可回滚目标');
  assert.deepStrictEqual(
    view.rollbackTargets.map((t) => t.seq),
    [3, 1],
    '最近的快照排在最前（治理台一键回滚的缺省目标）',
  );
  assert.deepStrictEqual(
    view.rollbackTargets.map((t) => t.skillCount),
    [3, 2],
  );
});

test('F2 只读：取视图不改变台账（条目数/验签结论/回滚可用性都不受影响）', () => {
  const { ledger, service } = makeLedger();
  const before = ledger.list().length;
  const verifyBefore = ledger.verify();
  service.view();
  service.view();
  assert.strictEqual(ledger.list().length, before, '取视图不得写入条目');
  assert.deepStrictEqual(ledger.verify(), verifyBefore, '链结论不得因只读访问而改变');
  // 回滚仍可用（入口是"预览+执行"两段式，取视图不等于执行回滚）。
  assert.doesNotThrow(() => ledger.rollback(1));
});
