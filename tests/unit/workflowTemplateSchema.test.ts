/**
 * Wave B4：第二个资产类型描述符 `WorkflowTemplateSchema` 的判据。
 *
 * 判据口径：
 * - 结构校验：非对象 / 字段缺失 / 空步 / 步骤名重复 / **依赖悬空** 全部即拒（原因可行动）；
 * - 评估契约：依赖满足率（0..1；无依赖恒 1），且**只对合法模板出分**（非法恒 0，fail-closed）；
 * - 「合法 ⇒ 满足率 1」是刻意的：本类型的校验与度量指向同一件事（可执行性），不各说各话。
 *
 * 变异自证：把 `validate` 换成恒 `{ok:true}` ⇒ 悬空依赖负例立刻红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkflowTemplateSchema,
  type WorkflowTemplate,
} from '../../src/capability/schemas/workflowTemplateSchema.js';

/**
 * 造一个合法模板。
 * @param name 模板名
 * @returns WorkflowTemplate
 */
function templateOf(name: string): WorkflowTemplate {
  return {
    name,
    description: `${name} 模板`,
    inputs: ['repo'],
    steps: [
      { name: 'scan', action: '扫描仓库', requires: ['repo'], produces: ['findings'] },
      { name: 'fix', action: '按清单修复', requires: ['findings'], produces: ['patch'] },
    ],
  };
}

/**
 * 取校验失败原因（断言用；未拒绝即抛断言错误）。
 * @param schema 类型描述符
 * @param asset 待校验资产
 * @returns 失败原因
 */
function reasonOf(schema: WorkflowTemplateSchema, asset: unknown): string {
  const verdict = schema.validate(asset);
  assert.strictEqual(verdict.ok, false, `本应被拒：${JSON.stringify(asset)}`);
  return verdict.ok ? '' : verdict.reason;
}

test('B4 WorkflowTemplateSchema 校验：两类正例（有输入 / 无输入无依赖）', () => {
  const schema = new WorkflowTemplateSchema();
  assert.deepStrictEqual(schema.validate(templateOf('t1')), { ok: true });
  assert.deepStrictEqual(
    schema.validate({
      name: 't2',
      description: 'd',
      inputs: [],
      steps: [{ name: 's', action: 'a', requires: [], produces: [] }],
    }),
    { ok: true },
  );
});

test('B4 WorkflowTemplateSchema 校验：五类负例（非对象 / 字段空 / 空步 / 重名 / 悬空依赖）', () => {
  const schema = new WorkflowTemplateSchema();
  assert.match(reasonOf(schema, null), /必须是对象/);
  assert.match(
    reasonOf(schema, { name: '', description: 'd', inputs: [], steps: [] }),
    /字段 name 缺失或为空/,
  );
  assert.match(
    reasonOf(schema, { name: 'x', description: 'd', inputs: [], steps: [] }),
    /steps 必须是非空数组/,
  );
  assert.match(
    reasonOf(schema, {
      name: 'x',
      description: 'd',
      inputs: [],
      steps: [
        { name: 's', action: 'a', requires: [], produces: [] },
        { name: 's', action: 'a', requires: [], produces: [] },
      ],
    }),
    /步骤名重复: s/,
  );
  assert.match(
    reasonOf(schema, {
      name: 'x',
      description: 'd',
      inputs: [],
      steps: [{ name: 's', action: 'a', requires: ['nowhere'], produces: [] }],
    }),
    /依赖悬空: nowhere/,
  );
  assert.match(
    reasonOf(schema, {
      name: 'x',
      description: 'd',
      inputs: [],
      steps: [{ name: 's', action: 'a', requires: 'not-array', produces: [] }],
    }),
    /requires 必须是字符串数组/,
  );
});

test('B4 WorkflowTemplateSchema 度量：依赖满足率（前序产出可满足后续依赖）+ 非法恒 0', () => {
  const schema = new WorkflowTemplateSchema();
  const bench = schema.evalContract({ evaluator: 'test' });
  const template = templateOf('t3');
  assert.strictEqual(bench(template), 1, '合法模板的依赖全部可满足 ⇒ 1');
  assert.strictEqual(WorkflowTemplateSchema.satisfactionOf(template), 1);
  assert.strictEqual(
    bench({ ...template, inputs: [] }),
    0,
    '非法（悬空依赖）资产恒 0（fail-closed：量不出来不给分）',
  );
  assert.strictEqual(
    WorkflowTemplateSchema.satisfactionOf({
      name: 't4',
      description: 'd',
      inputs: [],
      steps: [{ name: 's', action: 'a', requires: [], produces: [] }],
    }),
    1,
    '无依赖 ⇒ 满足率恒 1（空集合的口径写死，不留 NaN）',
  );
});

test('B4 WorkflowTemplateSchema 类型面：kind / 默认档 / 台账语义如实', () => {
  const schema = new WorkflowTemplateSchema();
  assert.strictEqual(schema.kind, 'workflow-template');
  assert.strictEqual(schema.version, 1);
  assert.strictEqual(schema.defaultTrustTier, 'core');
  assert.strictEqual(schema.defaultIsolation, 'in-process');
  assert.deepStrictEqual(schema.ledgerSemantics, {
    chain: 'promotion',
    snapshot: 'registry-full',
  });
});
