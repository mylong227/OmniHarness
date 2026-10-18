// 上下文容量面板的缓存展示语义单测（缺口 B 的 UI 侧护栏）。
//
// 背景：命中率是「实测值」——它只统计**上报了缓存字段**的模型调用（Σ cached / Σ prompt）。
// 这带来两个必须被锁死的展示语义，否则面板会把「没有数据」和「命中率为 0」混为一谈：
//   1. 无任何上报调用时 → 显示「—」并说明原因，绝不显示 `0%`；
//   2. 有上报但确实 0 命中时 → 显示 `0%`，且必须带调用次数，便于判断样本量。
// 另外锁死 `source` 的显式呈现（实测 / 估算），避免把估算值当成实测事实。
//
// 全部为纯逻辑，node 直跑 web/dist 编译产物。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ContextUsageView } from '../src/ui/models/ContextUsageView.ts';
import type {
  ContextUsageReport,
  ContextCacheStat,
  ContextCacheLastCall,
  CacheMissCause,
} from '../src/types/models.ts';

/**
 * 造一份最小可用的 context.usage 报告。
 * @param over 覆盖字段（source / cache / usedTokens / windowTokens）
 * @returns 报告对象
 */
function report(over: Partial<ContextUsageReport> = {}): ContextUsageReport {
  return {
    threadId: 't1',
    windowTokens: 128000,
    usedTokens: 1000,
    percent: 0.8,
    rows: [],
    mcpToolCount: 0,
    systemToolCount: 0,
    source: 'measured',
    cache: { promptTokens: 0, cachedPromptTokens: 0, calls: 0 },
    collectedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('缓存命中率：无上报调用时显示「—」而不是 0%', () => {
  const view = new ContextUsageView(report());
  assert.strictEqual(view.cacheText, '—');
  assert.strictEqual(view.cacheHint, '端点未上报缓存字段');
  assert.strictEqual(view.cacheText.includes('0%'), false, '不得把「无数据」显示成 0%');
});

test('缓存命中率：有上报且命中为 0 时显示 0%，并带调用次数', () => {
  const view = new ContextUsageView(
    report({ cache: { promptTokens: 6000, cachedPromptTokens: 0, calls: 6, hitRate: 0 } }),
  );
  assert.strictEqual(view.cacheText, '0%');
  assert.strictEqual(view.cacheHint, '基于 6 次调用');
});

test('缓存命中率：一位小数并按后端口径直接呈现（不二次舍入）', () => {
  const a = new ContextUsageView(
    report({ cache: { promptTokens: 1000, cachedPromptTokens: 333, calls: 2, hitRate: 33.3 } }),
  );
  assert.strictEqual(a.cacheText, '33.3%');
  const b = new ContextUsageView(
    report({ cache: { promptTokens: 1000, cachedPromptTokens: 900, calls: 2, hitRate: 90 } }),
  );
  assert.strictEqual(b.cacheText, '90%', '整数百分比不带 .0');
  const c = new ContextUsageView(
    report({ cache: { promptTokens: 1000, cachedPromptTokens: 1000, calls: 3, hitRate: 100 } }),
  );
  assert.strictEqual(c.cacheText, '100%');
});

test('缓存命中率：非有限值 fail-closed 显示「—」（不产出 NaN%）', () => {
  const view = new ContextUsageView(
    report({ cache: { promptTokens: 100, cachedPromptTokens: 1, calls: 1, hitRate: NaN } }),
  );
  assert.strictEqual(view.cacheText, '—');
});

test('来源标注：实测 / 估算 显式呈现，空数据不标注', () => {
  assert.strictEqual(new ContextUsageView(report({ source: 'measured' })).sourceLabel, '实测');
  assert.strictEqual(new ContextUsageView(report({ source: 'estimated' })).sourceLabel, '估算');
  assert.strictEqual(new ContextUsageView(report({ source: 'empty' })).sourceLabel, '');
});

test('来源与缓存相互独立：估算来源下缓存数值仍按实测呈现（不被打成估算）', () => {
  const view = new ContextUsageView(
    report({
      source: 'estimated',
      cache: { promptTokens: 1000, cachedPromptTokens: 250, calls: 4, hitRate: 25 },
    }),
  );
  assert.strictEqual(view.sourceLabel, '估算', '明细是估算');
  assert.strictEqual(view.cacheText, '25%', '缓存来自事件里的真实 usage，不是估算');
  assert.strictEqual(view.cacheHint, '基于 4 次调用');
});

test('空数据：isEmpty 为真且命中率不谎报为 0%', () => {
  const view = new ContextUsageView(report({ source: 'empty', usedTokens: 0, percent: 0 }));
  assert.strictEqual(view.isEmpty, true);
  assert.strictEqual(view.cacheText, '—');
});

/**
 * 造一份带分因的缓存统计。
 * @param lastCall 最近一次调用的分因（缺省不带该字段，模拟旧服务端）
 * @param over 其余缓存字段覆盖
 * @returns cache 对象
 */
function cacheWith(
  lastCall?: ContextCacheLastCall,
  over: Partial<ContextCacheStat> = {},
): ContextCacheStat {
  return {
    promptTokens: 2000,
    cachedPromptTokens: 0,
    calls: 2,
    hitRate: 0,
    ...(lastCall === undefined ? {} : { lastCall }),
    ...over,
  };
}

test('分因短标签：可行动的分因给一句话标签，命中与无数据都不给', () => {
  const label = (cause: CacheMissCause) =>
    new ContextUsageView(
      report({
        cache: cacheWith({
          cause,
          reason: '理由',
          evidence: {},
          promptTokens: 1000,
          cachedPromptTokens: 0,
        }),
      }),
    ).cacheCauseLabel;
  assert.strictEqual(label('prefix-rewrite'), '前缀被改写');
  assert.strictEqual(label('ttl-expired'), '缓存已过期');
  assert.strictEqual(label('cold-start'), '首次请求');
  assert.strictEqual(label('not-reported'), '端点未上报');
  assert.strictEqual(label('unknown'), '原因不明');
  assert.strictEqual(label('hit'), '', '命中不需要运维动作，常驻标签只会变成噪声');
  assert.strictEqual(
    new ContextUsageView(report()).cacheCauseLabel,
    '',
    '无上报调用（calls=0）不得给标签',
  );
});

test('分因详情：悬停文案 = 样本量 + 一句话理由；不得出现 undefined', () => {
  const view = new ContextUsageView(
    report({
      cache: cacheWith({
        cause: 'prefix-rewrite',
        reason: '相邻请求公共前缀占比 0.500 < 0.9',
        evidence: { prefixReuseRatio: 0.5 },
        promptTokens: 1000,
        cachedPromptTokens: 0,
      }),
    }),
  );
  assert.strictEqual(view.cacheDetail, '基于 2 次调用 · 相邻请求公共前缀占比 0.500 < 0.9');
  assert.strictEqual(view.cacheDetail.includes('undefined'), false);
  // 无上报调用：退化为原来的 hint（此时"理由"与 hint 同义，重复一遍只会更长）。
  assert.strictEqual(new ContextUsageView(report()).cacheDetail, '端点未上报缓存字段');
});

test('旧服务端兼容：没有 lastCall 字段时按「没有分因」渲染（宁少说，不显示 undefined）', () => {
  const view = new ContextUsageView(
    report({ cache: { promptTokens: 1000, cachedPromptTokens: 900, calls: 1, hitRate: 90 } }),
  );
  assert.strictEqual(view.cacheCauseLabel, '');
  assert.strictEqual(view.cacheDetail, '基于 1 次调用');
  assert.strictEqual(view.cacheDetail.includes('undefined'), false);
});