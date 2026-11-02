/**
 * WorkflowMemory 双面装配的**同步**判据（2026-11-01，接线盘点发现 9 的兜底）。
 *
 * 背景：`workflow_memory` 的存储有两个消费者，各构造一个 `WorkflowMemoryStore` 实例——
 * ① 模型工具面（`ConfigToolRegistry.registerAuxiliaryTools`，selfVerify 开启时注册工具）；
 * ② 回合末沉淀/召回面（`composition/runtime.ts` 的 `runtime.workflowMemory`，同一开关）。
 * 文件型存储现读现写、两实例功能等价，**真正的风险是两处开关条件漂移**：一侧开了另一侧没开，
 * 就会出现「模型能查但回合不沉淀」或反之的半接线。结构统一（单一实例穿三层）成本大于收益，
 * 故以本判据把同步义务显式钉住：selfVerify 开 ⇒ 两面同时存在；关 ⇒ 两面同时缺席。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ConfigFactory } from '../../src/kernel/config/configFactory.ts';
import { Runtime } from '../../src/apps/composition/runtime.ts';
import { MockModel } from '../../src/kernel/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/kernel/adapters/storage/memoryStorage.ts';
import { SilentEventPort } from '../../src/kernel/adapters/event/silentEventPort.ts';
import { tempWorkspace } from '../helpers/tempWorkspace.ts';

/** 最小可用配置（selfVerify 开关为唯一变量）。 */
const base = (withSelfVerify: boolean): Parameters<typeof ConfigFactory.build>[0] => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 4,
  model: new MockModel(),
  storage: new MemoryStorage(),
  events: new SilentEventPort(),
  ...(withSelfVerify ? { selfVerify: { enabled: true as const, command: 'echo ok' } } : {}),
});

test('① selfVerify 开：工具面与沉淀面同时存在（同步义务钉住）', async () => {
  const config = ConfigFactory.build(base(true));
  const names = config.tools.list().map((tool) => tool.name);
  assert.ok(names.includes('workflow_memory'), 'selfVerify 开 ⇒ workflow_memory 工具必须注册');
  const runtime = Runtime.createRuntime({ ...config, approvals: config.approvals });
  assert.ok(
    runtime.workflowMemory !== undefined,
    'selfVerify 开 ⇒ runtime.workflowMemory（沉淀面）必须装配；若此处红而工具在，说明 runtime 侧开关被改——两处必须同步（见文件头注释）',
  );
});

test('② selfVerify 关：两面同时缺席（不出现半接线）', async () => {
  const config = ConfigFactory.build(base(false));
  const names = config.tools.list().map((tool) => tool.name);
  assert.ok(!names.includes('workflow_memory'), 'selfVerify 关 ⇒ 工具不注册');
  const runtime = Runtime.createRuntime({ ...config, approvals: config.approvals });
  assert.ok(runtime.workflowMemory === undefined, 'selfVerify 关 ⇒ 沉淀面不装配');
});
