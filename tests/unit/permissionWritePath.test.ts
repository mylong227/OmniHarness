/**
 * 权限规则的**写入路径**判据（Web 交付 permission 编辑器前置，2026-10-11）。
 *
 * ## 为什么先修后端再做编辑器
 *
 * 编辑器让用户直接写规则 ⇒ **写入路径的校验就是安全边界**。做之前实测发现一处真缺陷：
 * `permission.rules[i]` 缺 `decision` 时**通过校验**（`checkDecision` 对 `undefined` 放行），
 * 而消费方 `RuleApproval.matchingDecisions` 只是 `map(rule => rule.decision)` ⇒ 该规则
 * `decisions=[undefined]`，`deny/ask/allow` 三条分支全不命中 ⇒ **规则静默不生效**。
 * 用户以为"我给 shell 加了限制"，实际什么都没发生——正是本仓反复记录的"配了但从不生效"。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 缺 `decision` ⇒ **写入路径**（`normalizeConfig`）必须拦下，且消息说明"不会生效" | 编辑器可落盘 no-op 规则（用户以为配了限制） |
 * | ② | 完整规则必须通过（正对照） | ①可能是"什么都拦" |
 * | ③ | 未知字段 / 非法枚举 / 字段类型错仍必须拦 | 回归 |
 * | ④ | **类型契约与运行期校验一致**：`ApprovalRule` 要求 `decision` 必填（编译期），运行期也必须拦 —— 二者不得各说一套 | 声明强于实现（本仓 G 系列反复记录） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../../src/config/configError.js';
import { PermissionConfigValidator } from '../../src/config/permissionConfigValidator.js';
import type { ApprovalRule } from '../../src/adapters/approval/approvalRule.js';

/** 走**写入路径**校验一条 permission 段，返回错误消息（通过时为 undefined）。 */
function writePathError(permission: unknown): string | undefined {
  try {
    ConfigError.normalizeConfig({ permission } as unknown as Record<string, unknown>);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 编译期断言：`T` 必须为 true。 */
type Assert<T extends true> = T;

/** 类型级可赋值性：`A` 能否赋给 `B`。 */
type Assignable<A, B> = A extends B ? true : false;

test('① 缺 decision 的规则必须被**写入路径**拦下，且消息点明"不会生效"', () => {
  const error = writePathError({ rules: [{ toolName: 'shell' }] });
  assert.ok(error !== undefined, '缺 decision 必须拦下（否则编辑器能落盘永不生效的规则）');
  assert.match(String(error), /缺 decision/u, '必须点名缺的字段');
  assert.match(String(error), /不会生效/u, '必须说明后果（否则用户不知道这条规则等于没写）');
  assert.match(String(error), /allow \| deny \| ask/u, '必须给出合法取值');

  // 同一判定在**校验器**这一层也要成立（写入路径只是它的一个调用方，不能只修一半）。
  const viaValidator = new PermissionConfigValidator().validate({
    permission: { rules: [{ toolName: 'shell' }] },
  } as never);
  assert.ok(viaValidator !== undefined, '校验器自身也必须拦下缺 decision 的规则');
});

test('② 正对照：完整规则必须通过（否则①可能是"什么都拦"）', () => {
  assert.strictEqual(
    writePathError({ rules: [{ decision: 'deny', toolName: 'shell', commandGlob: '*rm -rf*' }] }),
    undefined,
    '完整规则必须写入成功',
  );
  assert.strictEqual(writePathError({ rules: [] }), undefined, '空规则集是合法状态');
  assert.strictEqual(writePathError({ defaultDecision: 'ask' }), undefined, '只改默认裁决也合法');
});

test('③ 其余三类非法仍必须拦（未知字段 / 非法枚举 / 类型错）', () => {
  assert.match(String(writePathError({ rules: [{ decision: 'allow', bogus: 1 }] })), /未知配置项/u);
  assert.match(String(writePathError({ rules: [{ decision: 'permit' }] })), /非法，允许/u);
  assert.match(
    String(writePathError({ rules: [{ decision: 'allow', toolName: 7 }] })),
    /非空字符串/u,
  );
});

test('④ 类型契约与运行期校验一致：`decision` 两边都是必填（附编译期断言）', () => {
  // 编译期：缺 decision 的形状**不可**赋给契约（放宽成可选即此处编译失败）。
  type _DecisionRequired = Assert<
    Assignable<{ toolName: string }, ApprovalRule> extends false ? true : false
  >;
  // 运行期：同一形状必须被拦（① 已验）。两处一起看，才算"声明 ≡ 实现"。
  const missing: unknown = { toolName: 'shell' };
  assert.ok(
    writePathError({ rules: [missing] }) !== undefined,
    '类型说必填、运行期却放行 ⇒ 声明强于实现',
  );
});
