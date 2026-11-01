/**
 * `quota.set` 日预算校验判据（2026-11-01 口径对齐）。
 *
 * 被修的缺陷：`QuotaService.update` 的 JSDoc 一直声称「日预算非正数时抛错（fail-closed）」，
 * 实现却从未校验——`quota.set({ dailyTokens: 0 })` 会静默落盘并把当日预算清成 0
 * （effectiveTokens=0 ⇒ 面板显示剩余 0%）。本判据钉住：0 / 负数 / 非有限数一律抛错
 * 且**不触碰存储**；正数照常写入。UI 编辑器（CapacityDock 的 BudgetEditor）同口径拦截。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { QuotaService } from '../../src/server/services/quotaService.ts';
import type { QuotaStore } from '../../src/server/services/quotaStore.ts';
import type { SessionArchive } from '../../src/server/services/session/sessionArchive.ts';

/** 记录写入的假存储 + 最小假存档（update 校验不依赖它们的行为）。 */
const makeService = (): { service: QuotaService; writes: unknown[] } => {
  const writes: unknown[] = [];
  const store = {
    read: () => ({ dailyTokens: 1000 }),
    write: (settings: { dailyTokens: number }) => {
      writes.push(settings);
    },
  } as unknown as QuotaStore;
  const service = new QuotaService({
    store,
    usage: {} as unknown as SessionArchive,
    models: () => [],
  });
  return { service, writes };
};

test('① 日预算非正数（0 / 负数 / NaN）一律抛错且不落盘', () => {
  const { service, writes } = makeService();
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY * -1]) {
    assert.throws(
      () => service.update({ dailyTokens: bad }),
      /正数/u,
      `dailyTokens=${String(bad)} 必须被拒`,
    );
  }
  assert.deepStrictEqual(writes, [], '被拒的值不得触碰存储');
});

test('② 正数日预算照常写入', () => {
  const { service, writes } = makeService();
  service.update({ dailyTokens: 2000 });
  assert.deepStrictEqual(writes, [{ dailyTokens: 2000 }]);
  // 未提供 dailyTokens = 不变更（既有语义）。
  service.update({});
  assert.deepStrictEqual(writes, [{ dailyTokens: 2000 }]);
});
