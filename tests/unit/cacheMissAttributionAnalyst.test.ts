/**
 * 缓存未命中**分因**判据（2026-10-11，目标项「缓存命中率分因」）。
 *
 * 判据的组织方式：**每个分因都要能被单独触发，且换掉它那条信号就必须换因**——
 * 单看"某个输入得到某个结论"是恒真断言，必须成对给（"信号在 ⇒ 这个因 / 信号换 ⇒ 那个因"）。
 * 另外钉住**优先级**（`not-reported` 必须最先、`prefix-rewrite` 必须早于 `ttl-expired`），
 * 以及两条边界（复用率/间隔**恰好等于**阈值时不得误判）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrefixStability } from '../../src/context/prefixStability.js';
import { CacheMissAttributionAnalyst } from '../../src/observability/cacheMissAttributionAnalyst.js';

const { attribute, attributeFromTexts, DEFAULT_PROMPT_CACHE_TTL_MS, PREFIX_REUSE_FLOOR } =
  CacheMissAttributionAnalyst;

test('① not-reported 优先级最高：端点没给字段时，任何其它信号都不得把它改判成"未命中"', () => {
  const signals = {
    promptTokens: 10_000,
    // 故意给出"看起来很糟"的前缀与间隔 —— 若优先级写错，这里会被判成 prefix-rewrite / ttl-expired。
    prefixReuseRatio: 0.1,
    gapMs: 60 * 60_000,
  };
  const notReported = attribute({ ...signals });
  assert.strictEqual(notReported.cause, 'not-reported');
  assert.match(notReported.reason, /假读数/u, '理由必须点明"0% 是假读数"，否则用户会去改提示词');

  // **正对照**：补上"上报了 0 命中"这一个字段 ⇒ 同一组信号必须换因（前缀被打断）。
  const reported = attribute({ ...signals, cachedPromptTokens: 0 });
  assert.strictEqual(reported.cause, 'prefix-rewrite', reported.reason);
});

test('② 冷启动 vs 有前序：hasPreviousRequest 决定 0% 是否属正常', () => {
  const cold = attribute({ promptTokens: 5_000, cachedPromptTokens: 0 });
  assert.strictEqual(cold.cause, 'cold-start');
  // 正对照：同一组数字，声明"有前序请求" ⇒ 不能再报冷启动（且无其它信号 ⇒ unknown）。
  const warm = attribute({ promptTokens: 5_000, cachedPromptTokens: 0, hasPreviousRequest: true });
  assert.strictEqual(warm.cause, 'unknown', warm.reason);
});

test('③ 前缀被打断优先于 TTL：复用率低于下限即报 prefix-rewrite（本机可控那类）', () => {
  const atFloorMinusEpsilon = attribute({
    promptTokens: 9_000,
    cachedPromptTokens: 0,
    prefixReuseRatio: PREFIX_REUSE_FLOOR - 0.001,
    gapMs: 10 * 60_000, // TTL 也已过期，但前缀问题更该先报
  });
  assert.strictEqual(atFloorMinusEpsilon.cause, 'prefix-rewrite');
  assert.match(atFloorMinusEpsilon.reason, /PrefixStability/u, '理由必须指向可动的那个面');

  // 正对照：只把复用率抬到下限之上 ⇒ 换成 ttl-expired（证明③不是恒真）。
  const above = attribute({
    promptTokens: 9_000,
    cachedPromptTokens: 0,
    prefixReuseRatio: PREFIX_REUSE_FLOOR,
    gapMs: 10 * 60_000,
  });
  assert.strictEqual(above.cause, 'ttl-expired', above.reason);
});

test('④ 边界：复用率/间隔**恰好等于**阈值时不得误判（下限是严格的）', () => {
  const boundary = attribute({
    promptTokens: 1_000,
    cachedPromptTokens: 0,
    prefixReuseRatio: PREFIX_REUSE_FLOOR,
    gapMs: DEFAULT_PROMPT_CACHE_TTL_MS,
  });
  assert.strictEqual(boundary.cause, 'unknown', '恰好等于阈值应落到 unknown，而不是被判成越界');
});

test('⑤ hit 与证据：有命中时不报未命中，且证据含全部原始数字（JSON 安全）', () => {
  const hit = attribute({ promptTokens: 1_000, cachedPromptTokens: 250, prefixReuseRatio: 0.1 });
  assert.strictEqual(hit.cause, 'hit');
  assert.match(hit.reason, /250\/1000/u, '理由应带具体命中量');

  const unknown = attribute({
    promptTokens: 1_000,
    cachedPromptTokens: 0,
    hasPreviousRequest: true,
  });
  assert.deepStrictEqual(unknown.evidence, {
    promptTokens: 1_000,
    cachedPromptTokens: 0,
    prefixReuseRatio: null,
    gapMs: null,
    ttlMs: DEFAULT_PROMPT_CACHE_TTL_MS,
  });
  // 证据必须可 JSON 序列化（缺失信号写成 null，而不是 undefined 被静默丢掉）。
  assert.strictEqual(JSON.parse(JSON.stringify(unknown.evidence)).prefixReuseRatio, null);
});

test('⑥ attributeFromTexts 必须复用 PrefixStability.prefixReuse（不得各写一份公共前缀算法）', () => {
  const previous = 'A'.repeat(1_000) + '尾部旧内容';
  const incoming = 'A'.repeat(1_000) + '尾部新内容';
  const byText = attributeFromTexts(previous, incoming, {
    promptTokens: 2_000,
    cachedPromptTokens: 0,
  });
  const expectedRatio = PrefixStability.prefixReuse(previous, incoming);
  assert.strictEqual(
    byText.evidence.prefixReuseRatio,
    expectedRatio,
    '文本入口的复用率必须与 PrefixStability.prefixReuse 逐位一致（口径漂移会让面板与治理各说各话）',
  );
  // 前缀长 1000 / 总长 > 1000 ⇒ 占比高于下限 ⇒ 不是 prefix-rewrite（说明这条入口真的算了比值）。
  assert.notStrictEqual(byText.cause, 'prefix-rewrite');
  assert.strictEqual(byText.evidence.hasPreviousRequest, undefined);
  assert.strictEqual(byText.cause, 'unknown');
});
