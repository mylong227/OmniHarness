import { strict as assert } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { ApprovalRule } from '../../src/adapters/approval/approvalRule.js';
import type { FileConfig } from '../../src/config/configFile.js';
import { PermissionConfigValidator } from '../../src/config/permissionConfigValidator.js';

/**
 * `src/adapters/approval/approvalRule.ts` 是**纯类型门面**：全文件只有两条 `export type ... from`，
 * 编译产物是 `export {};`（零执行行、零运行时导出）。故本文件不追求行覆盖，改用
 * **编译器级 + 结构级** 判据把契约形状与契约链钉住。
 */

/** 合法最简规则：只有必填的 `decision`（三个约束字段全缺席 = 「不限制」）。 */
const minimalRule: ApprovalRule = { decision: 'allow' };

/** 合法完整规则：三个可选约束 + 裁决。 */
const fullRule: ApprovalRule = {
  toolName: 'shell',
  commandPrefix: 'git ',
  commandGlob: '*--force*',
  decision: 'deny',
};

// ── 编译期钉子（**类型级正断言**，2026-10-11 改写）────────────────────────────────
//
// 改写动机：原先这五条用 `@ts-expect-error` 反向钉（"期望这里报错"）。但本仓编码标准把
// `@ts-ignore` / `@ts-expect-error` 一律计为「类型逃逸」并由增量门禁阻断（既有
// `typedServiceKey.test.ts` 属历史存量）——而**测试里刻意的负断言不是逃逸，是反向收紧**。
// 现改为**正断言**：直接对类型求值，放宽契约即 `Assert<false>` ⇒ `tsc` 变红。
// 判据强度不降反升（不必依赖"指令未被使用"这条间接信号），且不再需要任何抑制指令。

/** 编译期断言：`T` 必须为 `true`，否则 `tsc` 报错（表达式使用处即落脚点）。 */
type Assert<T extends true> = T;

/** 类型级可赋值性判定：`A` 能否赋给 `B`。 */
type Assignable<A, B> = A extends B ? true : false;

/** `X` 与 `Y` 是否逐位同型（用函数参数的双向逆变比较，比裸 `extends` 严）。 */
type IfEquals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** 可从外部写入的键（`-readonly` 去掉只读后与原键比较，相同即可写）。 */
type WritableKeys<T> = {
  [P in keyof T]-?: IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] }> extends true
    ? P
    : never;
}[keyof T];

/** 钉子①：`decision` 必填——缺少它的形状**不可**赋给契约（改成可选即此处红）。 */
type _DecisionRequired = Assert<
  Assignable<{ toolName: string }, ApprovalRule> extends false ? true : false
>;

/** 钉子②：取值域封闭为三值——`'permit'` 不可赋给契约（放宽成 `string` 即红）。 */
type _DecisionEnumClosed = Assert<
  Assignable<{ decision: 'permit' }, ApprovalRule> extends false ? true : false
>;

/** 钉子③：约束字段类型固定为 `string`——`number` 不可赋给契约（放宽成 `string | number` 即红）。 */
type _ConstraintFieldsAreString = Assert<
  Assignable<{ decision: 'allow'; toolName: number }, ApprovalRule> extends false ? true : false
>;

/** 钉子④：契约字段**全部只读**——去掉任一 `readonly` 即可写键非空 ⇒ 红。 */
type _AllFieldsReadonly = Assert<WritableKeys<ApprovalRule> extends never ? true : false>;

/** 契约字段全集（由下一条类型断言强制与 `keyof ApprovalRule` 完全一致）。 */
const CONTRACT_FIELDS = ['toolName', 'commandPrefix', 'commandGlob', 'decision'] as const;

/**
 * 少写一个字段 / 契约新增字段而此处未同步 ⇒ 求值为 `never` ⇒ 赋值 `true` 编译失败。
 *
 * 这条同时承担原「未知字段被拒」的**类型侧**职责：字段集合与契约逐位一致（多一个字段会让
 * `keyof ApprovalRule` 超出清单 ⇒ `never`；少一个字段则由 `CONTRACT_FIELDS_EXHAUSTIVE` 的反向断言接住）。
 * **运行时侧**的"未知字段被拒"由本文件第三条判据（配置校验器白名单）独立覆盖，不靠这条兼任。
 */
type ExhaustiveFields<T extends readonly (keyof ApprovalRule)[]> =
  keyof ApprovalRule extends T[number] ? true : never;

/** 编译期钉子：字段清单必须与契约一一对应（不是子集）。 */
const CONTRACT_FIELDS_EXHAUSTIVE: ExhaustiveFields<typeof CONTRACT_FIELDS> = true;

test('契约形状：必填/封闭/枚举/只读由**类型级正断言**钉住（放宽任一即 tsc 变红）', () => {
  const samples: readonly ApprovalRule[] = [minimalRule, fullRule];
  assert.strictEqual(samples.length, 2);
  assert.strictEqual(minimalRule.decision, 'allow');
  assert.strictEqual(fullRule.decision, 'deny');
  assert.strictEqual(fullRule.toolName, 'shell');
  assert.strictEqual(CONTRACT_FIELDS_EXHAUSTIVE, true);
  assert.deepEqual(Object.keys(fullRule).sort(), [
    'commandGlob',
    'commandPrefix',
    'decision',
    'toolName',
  ]);
});

test('运行时形态：门面零运行时导出（类型被完全擦除），且检测手法本身非恒真', async () => {
  const facade = await import(
    new URL('../../src/adapters/approval/approvalRule.js', import.meta.url).href
  );
  assert.deepEqual(Object.keys(facade).sort(), []);
  assert.strictEqual('ApprovalRule' in facade, false, '接口只存在于类型空间，运行时不得有同名值');
  assert.strictEqual('ApprovalRuleDecision' in facade, false);

  // 正对照：同一检测手法换到「真有运行时导出」的模块上必须能发现东西——
  // 否则上面的空数组可能只是检测方法失灵造成的恒真。
  const control = await import(
    new URL('../../src/config/permissionConfigValidator.js', import.meta.url).href
  );
  assert.ok(Object.keys(control).includes('PermissionConfigValidator'));
});

test('契约链：契约字段全集必须被运行时配置校验器全部接受（新增字段漏登记即变红）', () => {
  const validator = new PermissionConfigValidator();
  const sampleValue: Record<keyof ApprovalRule, unknown> = {
    toolName: 'shell',
    commandPrefix: 'git ',
    commandGlob: 'git *',
    decision: 'allow',
  };
  assert.strictEqual(CONTRACT_FIELDS.length, Object.keys(sampleValue).length);

  for (const field of CONTRACT_FIELDS) {
    const rule: Record<string, unknown> = { decision: 'allow', [field]: sampleValue[field] };
    const error = validator.validate({ permission: { rules: [rule] } } as unknown as FileConfig);
    assert.strictEqual(
      error,
      undefined,
      `契约字段 ${field} 未获运行时校验器接受：${String(error)}`,
    );
  }

  // 正对照：白名单确实在拦——未登记字段必须被拒（否则上面的 undefined 是恒真）。
  const rejected = validator.validate({
    permission: { rules: [{ decision: 'allow', commandRegex: '^rm' }] },
  } as unknown as FileConfig);
  assert.match(String(rejected), /未知配置项/);
});

test('结构：门面只从 ports/approval 转发两条类型，不自建第二份契约定义', async () => {
  const source = await readFile(
    resolve(process.cwd(), 'src/adapters/approval/approvalRule.ts'),
    'utf8',
  );
  const exportLines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('export'));
  assert.deepEqual(exportLines, [
    "export type { ApprovalRuleDecision } from '../../ports/approval/approvalRuleDecision.js';",
    "export type { ApprovalRule } from '../../ports/approval/approvalRule.js';",
  ]);
  // 门面里不得自建 interface / class / 值导出：那会在适配器层长出第二份契约定义（双真源）。
  assert.doesNotMatch(source, /^(export )?(interface|class|const|function|enum)\s/m);
  assert.doesNotMatch(source, /^export type \w+ =/m);
});
