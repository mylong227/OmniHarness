/**
 * 信号路由器判据（GEE Kernel v1 · ① ingest 环；S3 期从 Kernel 拆出的独立职责）。
 *
 * 判据口径：
 * - 载荷缺失的信号**不造数**（kind 与载荷不一致时不计入路由计数）；
 * - 失败记录**有界**（超上限淘汰最旧者 ⇒ 同签名次数随之下降，挖掘器不看到被淘汰的历史）；
 * - 成功组合**原样**喂固化器 `observe`（不透传包装，固化器键口径不漂移）。
 *
 * 拆出独立判据的理由：路由策略是与编排无关的纯策略，Kernel 只应负责串环；
 * 独立判据保证「策略被替换/改坏」时能直接指认，而不是靠编排级判据间接暴露。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SignalIngestor } from '../../src/evolution/signalIngestor.js';
import type { CapabilityCrystallizerPort } from '../../src/ports/intelligence/capability.js';
import type { EvolutionSignal } from '../../src/ports/runtime/evolution.js';

/**
 * 造一条失败信号（kind='cycle'，location 决定挖掘器签名域）。
 * @param location 失败位置
 * @returns 进化信号
 */
function failureSignal(location: string): EvolutionSignal {
  return {
    kind: 'failure',
    key: `sig:${location}`,
    evidence: location,
    provenance: 'production',
    failure: { kind: 'cycle', location, message: 'm' },
  };
}

test('SignalIngestor：载荷缺失不造数 / 成功组合原样喂固化器', () => {
  const combinations: (readonly string[])[] = [];
  const crystallizer = {
    observe: (combination: readonly string[]) => combinations.push(combination),
  } as unknown as CapabilityCrystallizerPort;
  const ingestor = new SignalIngestor({ crystallizer, failureThreshold: 2 });

  const routed = ingestor.ingest([
    // kind 与载荷不一致：不得计入路由计数（宁可少记，不得虚增）。
    { kind: 'failure', key: 'no-payload', evidence: 'e', provenance: 'production' },
    { kind: 'success', key: 'no-payload', evidence: 'e', provenance: 'production' },
    failureSignal('alpha/x'),
    {
      kind: 'success',
      key: 'a|b',
      evidence: 'e',
      provenance: 'production',
      success: { combination: ['a', 'b'] },
    },
  ]);

  assert.deepStrictEqual(
    routed,
    // E1+ 双源：路由结果新增 `distilled`（成功侧被蒸馏器接受为观测的条数）。
    // 本判据未注入蒸馏器 ⇒ 恒 0；成功侧的独立判据见 tests/unit/successPatternDistiller.test.ts。
    { failures: 1, successes: 1, distilled: 0 },
    '载荷缺失的信号不计入路由（不造数）',
  );
  assert.deepStrictEqual(combinations, [['a', 'b']], '成功组合原样喂固化器（不透传包装）');
});

test('SignalIngestor：失败记录有界——超上限淘汰最旧者，挖掘器只看得到留存的窗口', () => {
  const unbounded = new SignalIngestor({ failureThreshold: 2, maxFailureRecords: 8 });
  unbounded.ingest([failureSignal('alpha/x'), failureSignal('beta/y'), failureSignal('alpha/z')]);
  const proposals = unbounded.proposals();
  assert.strictEqual(proposals.length, 1, '记录留全 ⇒ 同签名 ×2 达阈升格提案');
  assert.strictEqual(proposals[0]?.signatureKey, 'cycle × alpha');

  const bounded = new SignalIngestor({ failureThreshold: 2, maxFailureRecords: 2 });
  bounded.ingest([failureSignal('alpha/x'), failureSignal('beta/y'), failureSignal('alpha/z')]);
  assert.deepStrictEqual(
    bounded.proposals(),
    [],
    '上限 2 ⇒ 最旧的 alpha/x 被淘汰，同签名只剩 1 次 → 不足阈（有界缓冲真实生效）',
  );
});
