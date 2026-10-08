/**
 * 受控执行条件（`when`）的**校验与裁决**判据（2026-10-08 增补能力）。
 *
 * ## 为什么这些判据必须存在
 *
 * `when` 是模型面入口（`run_workflow` 的实参）直接可达的字段，而它的失败形态**天生静默**：
 * - 指向不存在的步骤 ⇒ 条件永假、该步永远跳过（没有任何报错）；
 * - 指向未在 `dependsOn` 声明的步骤 ⇒ 读到上一轮的陈旧状态（时序错，最难查）；
 * - `status:'blocked'` 之类 ⇒ 把基础设施故障当业务分支（fail-open 的变体）；
 * - `outputMatches` 正则写错 ⇒ 永远不匹配。
 * 故全部引用必须在校验期解析干净，非法即抛（fail-closed）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkflowGuard } from '../../src/autonomy/workflowGuard.js';
import { WorkflowSpecError } from '../../src/autonomy/workflowSpecError.js';
import type { WorkflowStep } from '../../src/ports/autonomy/workflowStep.js';
import type { WorkflowStepStatus } from '../../src/ports/autonomy/workflowStepStatus.js';

/** 构造「A → B」两步，B 的条件由用例给出。 */
function twoSteps(guard: WorkflowStep['when']): readonly WorkflowStep[] {
  return [
    { id: 'A', prompt: 'a' },
    { id: 'B', prompt: 'b', dependsOn: ['A'], ...(guard !== undefined ? { when: guard } : {}) },
  ];
}

describe('WorkflowGuard.validate（规格期 fail-closed）', () => {
  it('合法条件通过（含 outputMatches）', () => {
    assert.doesNotThrow(() =>
      WorkflowGuard.validate(
        twoSteps({ step: 'A', status: 'failed', ...{ outputMatches: undefined } }),
      ),
    );
    assert.doesNotThrow(() =>
      WorkflowGuard.validate(twoSteps({ step: 'A', status: 'done', outputMatches: '通过|ok' })),
    );
  });

  it('引用不存在的步骤即拒绝', () => {
    assert.throws(
      () => WorkflowGuard.validate(twoSteps({ step: 'Z', status: 'done' })),
      WorkflowSpecError,
    );
  });

  it('被观察步骤不在 dependsOn 中即拒绝（防读到陈旧状态）', () => {
    const steps: readonly WorkflowStep[] = [
      { id: 'A', prompt: 'a' },
      { id: 'B', prompt: 'b', dependsOn: ['A'] },
      // C 观察 A 却不依赖 A：调度顺序无保证 ⇒ 必须拒绝。
      { id: 'C', prompt: 'c', dependsOn: ['B'], when: { step: 'A', status: 'done' } },
    ];
    assert.throws(() => WorkflowGuard.validate(steps), /必须同时出现在 dependsOn/);
  });

  it('自引用即拒绝', () => {
    const steps: readonly WorkflowStep[] = [
      { id: 'A', prompt: 'a', dependsOn: ['A'], when: { step: 'A', status: 'done' } },
    ];
    assert.throws(() => WorkflowGuard.validate(steps), /不得引用自身/);
  });

  it('非法终态即拒绝（blocked / cancelled 不许当分支条件）', () => {
    for (const status of ['blocked', 'cancelled', 'running'] as const) {
      assert.throws(
        () => WorkflowGuard.validate(twoSteps({ step: 'A', status: status as never })),
        /when\.status 只能是/,
      );
    }
  });

  it('非 done 状态声明 outputMatches 即拒绝（哑条件）', () => {
    assert.throws(
      () => WorkflowGuard.validate(twoSteps({ step: 'A', status: 'failed', outputMatches: 'x' })),
      /哑条件/,
    );
  });

  it('正则不可编译即拒绝（而不是运行期静默不匹配）', () => {
    assert.throws(
      () => WorkflowGuard.validate(twoSteps({ step: 'A', status: 'done', outputMatches: '([' })),
      /不是合法正则/,
    );
  });

  it('条件形状非法即拒绝', () => {
    assert.throws(() => WorkflowGuard.validate(twoSteps([] as never)), /when 必须是对象/);
    assert.throws(
      () => WorkflowGuard.validate(twoSteps({ status: 'done' } as never)),
      /when\.step/,
    );
    assert.throws(() => WorkflowGuard.validate(twoSteps({ step: 'A' } as never)), /when\.status/);
    assert.throws(
      () =>
        WorkflowGuard.validate(twoSteps({ step: 'A', status: 'done', outputMatches: 7 } as never)),
      /outputMatches 必须是字符串/,
    );
  });
});

describe('WorkflowGuard.decide（运行期裁决）', () => {
  /** 造一份终态表。 */
  const statusesOf = (
    entries: readonly (readonly [string, WorkflowStepStatus])[],
  ): Map<string, WorkflowStepStatus> => new Map(entries);

  it('终态命中且无 outputMatches ⇒ 执行', () => {
    const verdict = WorkflowGuard.decide(
      { step: 'A', status: 'failed' },
      statusesOf([['A', 'failed']]),
      {},
    );
    assert.strictEqual(verdict.run, true);
  });

  it('终态不命中 ⇒ 不执行且原因可读', () => {
    const verdict = WorkflowGuard.decide(
      { step: 'A', status: 'failed' },
      statusesOf([['A', 'done']]),
      {},
    );
    assert.strictEqual(verdict.run, false);
    assert.match(verdict.reason, /终态为 done，条件要求 failed/);
  });

  it('outputMatches 命中 ⇒ 执行；未命中 ⇒ 不执行', () => {
    const guard = { step: 'A', status: 'done' as const, outputMatches: '构建失败' };
    assert.strictEqual(
      WorkflowGuard.decide(guard, statusesOf([['A', 'done']]), { A: '构建失败：3 个错误' }).run,
      true,
    );
    const miss = WorkflowGuard.decide(guard, statusesOf([['A', 'done']]), { A: '构建通过' });
    assert.strictEqual(miss.run, false);
    assert.match(miss.reason, /产出不匹配/);
  });

  it('被观察步骤无终态记录 ⇒ 不执行（fail-closed，绝不默认跑）', () => {
    const verdict = WorkflowGuard.decide({ step: 'A', status: 'done' }, statusesOf([]), {});
    assert.strictEqual(verdict.run, false);
    assert.match(verdict.reason, /尚无终态记录/);
  });
});
