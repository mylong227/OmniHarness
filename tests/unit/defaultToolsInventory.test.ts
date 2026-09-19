/**
 * 默认工具集清单回归（P2-⑫ / P2-⑬）。
 *
 * 为什么单独钉这一条：本仓最高频的缺陷形态是「**声明未接线**」——工具类写在 `adapters/` 里、
 * 自身单测也能跑通，但组合根漏注册 ⇒ 模型在生产路径上**根本看不到它**（「库里有能力 ≠ 路径上生效」）。
 * 故此处断言的是 `ConfigFactory.build(...).tools`（**装配产物**），而不是工具类本身。
 *
 * 另锁一条语义：`extraTools` 与内置**同名时覆盖内置**（先反注册再注册）。
 * 背景：`web_fetch` 自本批起默认注册后，调用方再注入自己的 `web_fetch`
 * （如需要带鉴权的抓取实现）会撞上 `RegistryToolPort` 的重名拦截；
 * 而 `RegistryToolPort` 的类契约本就写明「可注册/替换/扩展」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigFactory } from '../../src/config/configFactory.js';
import type { ExtraTool, OmniHarnessConfig } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.js';
import type { ToolCall, ToolContext, ToolResult } from '../../src/ports/tool/tool.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 空转事件端口（本测试只关心装配产物，不关心事件流）。 */
class NullEventPort implements EventPort {
  /** 端口名。 */
  public readonly name = 'null';

  /**
   * 丢弃事件。
   * @param _event 运行时发出的事件（本测试不消费）。
   * @returns 无返回值。
   */
  public emit(_event: SessionEvent): void {
    /* 本测试不需要事件流 */
  }
}

/** 不回话的模型（装配期不会被调用）。 */
class SilentModel implements ModelPort {
  /** 端口名。 */
  public readonly name = 'silent';

  /**
   * 返回空文本。
   * @returns 空文本输出。
   */
  public async generate(): Promise<ModelOutput> {
    return { text: '' };
  }
}

/** 注入的自定义抓取实现（用于验证「同名覆盖内置」）。 */
const CUSTOM_FETCH_MARK = 'custom-fetch-implementation';

/** 与内置同名的自定义工具。 */
const customFetcher = (): ExtraTool => ({
  definition: {
    name: 'web_fetch',
    description: '自定义抓取实现（覆盖内置）',
    parameters: { type: 'object', properties: {} },
  },
  handler: async (call: ToolCall): Promise<ToolResult> => ({
    callId: call.id,
    ok: true,
    output: CUSTOM_FETCH_MARK,
  }),
});

/**
 * 构造最小可用配置基线。
 * @param extraTools 追加/覆盖的自定义工具（缺省为空）。
 * @returns 可直接喂给 `ConfigFactory.build` 的配置片段。
 */
const base = (extraTools: readonly ExtraTool[] = []): OmniHarnessConfig => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 2,
  model: new SilentModel(),
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new NullEventPort(),
  extraTools,
});

test('默认工具集真含 P2-⑫⑬ 三个新工具（装配产物，非类自身）', () => {
  const names = ConfigFactory.build(base())
    .tools.list()
    .map((definition) => definition.name);

  for (const expected of ['web_fetch', 'view_image', 'shell_job']) {
    assert.ok(names.includes(expected), `装配产物缺 ${expected}，实际：${names.join(',')}`);
  }
  // 默认注册的应是**直接可见**的工具（不是 deferred，否则要 tool_search 才发现）。
  assert.ok(!names.includes('web_search'), 'web_search 未配置实现时不应默认注册（避免批量失败）');
});

test('extraTools 与内置同名时覆盖内置，而非抛「工具重复注册」', async () => {
  const config = ConfigFactory.build(base([customFetcher()]));
  const names = config.tools.list().map((definition) => definition.name);

  assert.strictEqual(
    names.filter((name) => name === 'web_fetch').length,
    1,
    '覆盖后 web_fetch 应仍只有一个',
  );

  const context: ToolContext = { sessionId: 's1', workspaceRoot: tempWorkspace() };
  const result = await config.tools.execute(
    { id: 'c1', name: 'web_fetch', arguments: { url: 'https://example.com' } },
    context,
  );

  assert.strictEqual(result.output, CUSTOM_FETCH_MARK, '调用应落到注入实现，而不是内置实现');
});
