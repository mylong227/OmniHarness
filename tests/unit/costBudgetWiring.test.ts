/**
 * P5 成本预算生产入口接线单测。
 *
 * 目标：证明 `costBudget*` 不再是「只能编程注入」的死字段——**走生产装配路径**
 * （`ConfigFactory.build`）与 **CLI 解析**（`parseArgs`）都能真正打开成本预算，
 * 且缺省不设时零行为变更（`costBudget` 为 undefined）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { parseArgs } from '../../src/cli/argParser.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/**
 * 构造最小可用配置基线（必填四项 + 静默事件端口；其余走默认实现）。
 * @returns 可再展开覆盖的配置片段。
 */
const base = (): {
  workspaceRoot: string;
  maxSteps: number;
  model: MockModel;
  storage: MemoryStorage;
  events: SilentEventPort;
} => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 4,
  model: new MockModel(),
  storage: new MemoryStorage(),
  events: new SilentEventPort(),
});

test('P5 缺省不设 costBudgetUsd ⇒ 不构造预算（零行为变更）', () => {
  const config = ConfigFactory.build(base());
  assert.strictEqual(config.costBudget, undefined);
});

test('P5 设 costBudgetUsd ⇒ 生产装配路径真构造预算并透传 softRatio / 行为', () => {
  const config = ConfigFactory.build({
    ...base(),
    costBudgetUsd: 5,
    costBudgetOnExceed: 'warn',
    costBudgetSoftRatio: 0.5,
  });
  assert.ok(config.costBudget !== undefined, 'costBudgetUsd 必须真的构造出预算实例');
  assert.strictEqual(config.costBudget.limitUsd, 5);
  assert.strictEqual(config.costBudget.softRatio, 0.5);
  assert.strictEqual(config.costBudget.blocking, false, "'warn' ⇒ 软预算（不阻断）");
});

test('P5 非正数 costBudgetUsd ⇒ 视为关闭', () => {
  assert.strictEqual(ConfigFactory.build({ ...base(), costBudgetUsd: 0 }).costBudget, undefined);
  assert.strictEqual(ConfigFactory.build({ ...base(), costBudgetUsd: -1 }).costBudget, undefined);
});

test('P5 预算存在时 budget_status 工具被注册（真实消费点）', () => {
  const config = ConfigFactory.build({ ...base(), costBudgetUsd: 1 });
  const names = config.tools.list().map((t) => t.name);
  assert.ok(names.includes('budget_status'), `应注册 budget_status，实为 ${names.join(',')}`);
});

test('P5 三个成本旗标被解析且取值不污染 prompt', () => {
  const args = parseArgs([
    '--prompt',
    'hi',
    '--cost-budget-usd',
    '2.5',
    '--cost-budget-on-exceed',
    'warn',
    '--cost-budget-soft-ratio',
    '0.6',
  ]);
  assert.strictEqual(args?.costBudgetUsd, 2.5);
  assert.strictEqual(args?.costBudgetOnExceed, 'warn');
  assert.strictEqual(args?.costBudgetSoftRatio, 0.6);
  assert.strictEqual(args?.prompt, 'hi', '取值必须登记 VALUE_FLAGS，否则会被并入 prompt');
});

test('P5 非法 on-exceed 取值 fail-closed（枚举白名单抛错）', () => {
  assert.throws(() => parseArgs(['--prompt', 'hi', '--cost-budget-on-exceed', 'bogus']));
});
