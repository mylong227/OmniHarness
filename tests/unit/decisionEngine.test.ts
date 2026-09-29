/**
 * 决策引擎端口 + Laya 适配器单测。
 *
 * 锁死两件事：
 *   ① **fail-open**：Laya 后端不可用（Python 缺失 / 未装 `laya` / 调用失败）时 `decide`
 *      必须返回 `{ available:false }` 且不抛错——决策引擎是质量信号，不得阻断主流程；
 *   ② **端口契约**：`noul` 原语返回 [0,1] 概率，调用方据此做 System-1 预判。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaDecisionEngine } from '../../src/adapters/laya/layaDecisionEngine.js';
import type {
  DecisionEngine,
  DecisionRequest,
  DecisionResponse,
} from '../../src/ports/decision/decisionEngine.js';

/** 替身决策引擎（返回固定 noul 概率），用于验证端口契约。 */
class StubDecisionEngine implements DecisionEngine {
  /** 端口名。 */
  public readonly name = 'stub';

  /** @returns 始终可用。 */
  public isAvailable(): boolean {
    return true;
  }

  /**
   * @param request 决策请求。
   * @returns 首题 noul=0.9 的答案。
   */
  public async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const firstKey = Object.keys(request.questions)[0] ?? 'passTest';
    return { answers: { [firstKey]: { noul: 0.9 } }, available: true };
  }
}

test('StubDecisionEngine：noul 原语返回概率', async () => {
  const engine = new StubDecisionEngine();
  const response = await engine.decide({
    state: 's',
    questions: { passTest: { kind: 'noul', instructions: 'i' } },
  });
  assert.strictEqual(response.available, true);
  assert.strictEqual(response.answers.passTest?.noul, 0.9);
});

test('LayaDecisionEngine：后端不可用时 fail-open 不抛错', () => {
  const engine = new LayaDecisionEngine({ pythonPath: 'this-python-does-not-exist-xyz' });
  assert.strictEqual(engine.isAvailable(), false);
  return engine
    .decide({ state: 'x', questions: { q: { kind: 'noul', instructions: '?' } } })
    .then((response) => {
      assert.strictEqual(response.available, false);
      assert.deepStrictEqual(response.answers, {});
    });
});
