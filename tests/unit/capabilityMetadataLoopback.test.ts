/**
 * Wave D 尾巴（`ARCHITECTURE_TARGET` §7 Wave D 判据）：**元数据可被 MCP 客户端消费（loopback）**。
 *
 * ## 判据为什么必须"过协议"而不是"调函数"
 *
 * 「导出元数据」有两个出口：CLI（**人**读）与 MCP 工具（**机器**读）。本判据走后者，且必须**真过协议**：
 * 用官方 SDK 的 `Client` 经 `InMemoryTransport` 连到本仓的 `SdkMcpServerAdapter`，
 * `listTools` 看到它、`callTool` 取回它——这样才排除了「函数能调通、但注册/映射/序列化任一环断了」的假绿。
 *
 * ## 钉住四条
 *
 * 1. **可达**：工具出现在 `tools/list` 里，且参数 schema 透传一致（模型知道怎么调）；
 * 2. **同源**：`callTool` 取回的元数据与 `AssetPackInstaller.metadataFor` **逐字段相同**
 *    （两处各拼一份必然漂移，故本工具只做取数+序列化）；
 * 3. **只读分类**：不在 `MUTATING_TOOL_NAMES` 内（plan 模式无需审批）；
 * 4. **fail-closed**：类型未注册 ⇒ `isError` + 可读原因；协议未启用 ⇒ 工具**根本不在清单里**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityMetadataTool } from '../../src/adapters/tool/capability/capabilityMetadataTool.js';
import { SdkMcpServerAdapter } from '../../src/adapters/mcp/sdkMcpServerAdapter.js';
import { CapabilityStackAssembler } from '../../src/config/capabilityStackAssembler.js';
import { TOOL_NAMES, MUTATING_TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { CapabilityStack } from '../../src/ports/config/capabilityStack.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../src/ports/tool/tool.js';

/**
 * 把「一个只读工具」包成真实 `ToolPort`（`SdkMcpServerAdapter` 的入参形状）。
 *
 * 这里刻意**只用真工具**、不留任何 Fake 行为：Fake 端口能证明协议通了，但证明不了**我们的工具**
 * 能被协议消费（本判据要的正是后者）。端口只做「清单 + 转发」，零逻辑。
 */
class SingleToolPort implements ToolPort {
  /** 端口标识名。 */
  public readonly name = 'capability-metadata-port';
  /** 已到达工具实现的调用（断言「真的走到 handle」用）。 */
  public readonly seen: string[] = [];

  /**
   * @param definition 工具定义
   * @param handle 工具执行函数（被测工具的真实实现）
   */
  public constructor(
    private readonly definition: ToolDefinition,
    private readonly handle: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>,
  ) {}

  /**
   * 列出工具定义。
   * @returns 单元素工具清单
   */
  public list(): readonly ToolDefinition[] {
    return [this.definition];
  }

  /**
   * 转发执行。
   * @param call 工具调用
   * @param context 工具上下文
   * @returns 工具结果
   */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    this.seen.push(call.name);
    return this.handle(call, context);
  }
}

/**
 * 建一套「已装了几条资产」的资产协议切片。
 * @returns 切片
 */
function stackWithAssets(): CapabilityStack {
  const stack = CapabilityStackAssembler.assemble({
    skillRegistry: new SkillRegistry(),
    config: { enabled: true },
  });
  assert.ok(stack !== undefined, '启用时必须装配出切片');
  stack.registry.put({
    asset: { name: 'alpha', description: 'd', instructions: 'SECRET-INSTRUCTIONS' },
    schemaKind: 'skill',
    lineage: { parents: [], operator: 'twist:a+b', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: {
      trustTier: 'evolved',
      isolation: 'vm',
      state: 'active',
      ledgerSeq: undefined,
    },
  });
  return stack;
}

/**
 * 取 MCP `callTool` 结果里的第一段文本。
 * @param result SDK 的 callTool 返回值
 * @returns 文本
 */
function firstText(result: unknown): string {
  const content =
    (result as { content?: readonly { type?: string; text?: string }[] }).content ?? [];
  const text = content.find((c) => c.type === 'text')?.text;
  assert.ok(typeof text === 'string' && text.length > 0, '必须返回文本内容');
  return text;
}

test('D 判据 loopback：MCP 客户端经 in-memory 传输 listTools 可见并 callTool 取回元数据', async () => {
  const stack = stackWithAssets();
  const tool = new CapabilityMetadataTool(() => stack);
  const port = new SingleToolPort(tool.definition, (call, ctx) => tool.handle(call, ctx));
  const adapter = new SdkMcpServerAdapter(port, { name: 'omniharness', version: '0.1.0' });
  const pair = await adapter.connectInMemory();
  try {
    // ① 可达 + schema 透传。
    const { tools } = await pair.client.listTools();
    const descriptor = tools.find((t) => t.name === TOOL_NAMES.capabilityMetadata);
    assert.ok(descriptor !== undefined, `tools/list 必须含 ${TOOL_NAMES.capabilityMetadata}`);
    assert.ok(
      (descriptor.description ?? '').includes('元数据'),
      '描述必须说明它返回什么（模型据此决定是否调用）',
    );
    assert.deepStrictEqual(
      (descriptor.inputSchema as { properties?: Record<string, unknown> }).properties?.['kind'],
      {
        type: 'string',
        description: '只取该类型（如 skill / workflow-template）；缺省返回全部已注册类型。',
      },
      'kind 参数 schema 必须透传（模型才知道可以按类型过滤）',
    );

    // ② 同源：协议取回的元数据 == 切片自算的元数据（逐字段）。
    const called = await pair.client.callTool({
      name: TOOL_NAMES.capabilityMetadata,
      arguments: { kind: 'skill' },
    });
    assert.notStrictEqual(called.isError, true, '正常调用不得是错误');
    const viaProtocol = JSON.parse(firstText(called)) as readonly unknown[];
    const expected = {
      kind: 'skill',
      version: stack.schemas.schemaOf('skill').version,
      defaultTrustTier: stack.schemas.schemaOf('skill').defaultTrustTier,
      defaultIsolation: stack.schemas.schemaOf('skill').defaultIsolation,
      assets: [
        {
          name: 'alpha',
          trustTier: 'evolved',
          isolation: 'vm',
          state: 'active',
          operator: 'twist:a+b',
        },
      ],
    };
    assert.deepStrictEqual(viaProtocol, [expected], '协议出口与切片自算必须逐字段相同');
    assert.ok(
      !firstText(called).includes('SECRET-INSTRUCTIONS'),
      '元数据不得含资产正文（instructions 明文）',
    );
    assert.deepStrictEqual(port.seen, [TOOL_NAMES.capabilityMetadata], '调用必须真实到达工具实现');

    // 缺省（不带 kind）⇒ 全部已注册类型。
    const all = await pair.client.callTool({ name: TOOL_NAMES.capabilityMetadata, arguments: {} });
    const allKinds = (JSON.parse(firstText(all)) as readonly { kind: string }[]).map((m) => m.kind);
    assert.deepStrictEqual(allKinds, [...stack.schemas.kinds()], '缺省必须列全部已注册类型');

    // ③ fail-closed：未注册类型 ⇒ isError + 可读原因（不是空数组）。
    const unknown = await pair.client.callTool({
      name: TOOL_NAMES.capabilityMetadata,
      arguments: { kind: 'operator' },
    });
    assert.strictEqual(unknown.isError, true, '未注册类型必须报错，不得返回空表');
    assert.match(firstText(unknown), /类型未注册：operator/);
  } finally {
    await pair.close();
  }
});

test('D 判据 只读分类：capability_metadata 不在写类集合内（plan 模式无需审批）', () => {
  const name = TOOL_NAMES.capabilityMetadata;
  assert.strictEqual(name, 'capability_metadata');
  assert.strictEqual(
    MUTATING_TOOL_NAMES.has(name),
    false,
    '它不落盘、不改事件流 ⇒ 必须属只读（错收进写类会让 plan 模式下每次读元数据都要审批）',
  );
  assert.ok(
    [...MUTATING_TOOL_NAMES].includes(TOOL_NAMES.writeFile),
    '正对照：写类工具确实在集合里（否则本判据可能因集合为空而恒绿）',
  );
});

test('D 判据 fail-closed：协议未启用时工具如实报未启用（不返回空元数据）', async () => {
  const tool = new CapabilityMetadataTool(() => undefined);
  const result = await tool.handle(
    { id: 'c1', name: TOOL_NAMES.capabilityMetadata, arguments: {} } as ToolCall,
    {} as ToolContext,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /capability 未启用/);
  assert.strictEqual(result.output, undefined, '未启用不得给"空元数据"冒充成功');
});
