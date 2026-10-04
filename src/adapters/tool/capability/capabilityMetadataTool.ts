/**
 * `capability_metadata` 工具（Wave D 尾巴 · ADR-0011）：把资产协议元数据暴露给 **MCP 客户端**。
 *
 * ## 为什么需要它（而不是「CLI 能打印就够了」）
 *
 * `ARCHITECTURE_TARGET_2026-10.md` §7 的 Wave D 判据里有一条独立要求：
 * 「**元数据可被 MCP 客户端消费（loopback）**」。CLI 打印是**人**读的出口，MCP 工具才是**机器**读的出口——
 * 元数据是给生态互描述用的（MCP Registry 风格），能被另一个 Agent/客户端经协议取走才算真的「导出」。
 *
 * ## 纪律
 *
 * 1. **只读**：不落盘、不改事件流，故**不进** `MUTATING_TOOL_NAMES`（plan 模式下无需审批即可调用）；
 * 2. **不臆造**：元数据一律来自 `AssetPackInstaller.metadataFor`（与 CLI `capability metadata` 同源），
 *    本工具只做「取数 + 序列化」，不自己拼字段——两处各拼一份必然漂移；
 * 3. **fail-closed**：协议未启用（`capability.enabled !== true`）时**如实报错**，
 *    而不是返回空表让人以为「协议在跑但没资产」；
 * 4. **不含资产内容**：只出公开字段（名字/档位/状态/算子），instructions 等明文不进元数据。
 *
 * @maturity L1 — 只读分类 / 与 CLI 同源 / 未启用如实拒 / 未注册类型如实拒 判据钉死
 * @maturityEvidence tests/unit/capabilityMetadataLoopback.test.ts
 */
import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import type { CapabilityStack } from '../../../ports/config/capabilityStack.js';
import type { RegistryMetadata } from '../../../ports/asset.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';

/**
 * 取资产协议切片（由组合根注入：`ConfigFactory` 在装配工具集时把已装配的切片交给它）。
 * @returns 切片；`capability.enabled !== true` 时为 undefined
 */
export type CapabilityStackLikeProvider = () => CapabilityStack | undefined;

/** 资产协议元数据工具（只读）。 */
export class CapabilityMetadataTool {
  /** 工具定义：`capability_metadata` 的名称、描述与参数 schema。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.capabilityMetadata,
    description:
      '读取本机资产协议（统一资产协议）的公开元数据：类型、契约版本、默认信任/隔离档位，' +
      '以及各资产的名称、当前档位、生命周期状态与溯核算子。可选 kind 参数只取某一类型。' +
      '只读，不含资产正文。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: '只取该类型（如 skill / workflow-template）；缺省返回全部已注册类型。',
        },
      },
    },
  };

  /**
   * @param stackOf 切片提供者（组合根注入；返回 undefined 表示协议未启用）
   */
  public constructor(private readonly stackOf: CapabilityStackLikeProvider) {}

  /**
   * 执行 `capability_metadata`：返回 MCP Registry 风格的公开元数据。
   * @param call 模型传入的工具调用（可带 `kind`）
   * @param _ctx 工具执行上下文（本工具不依赖会话状态）
   * @returns 成功时 `output` 为元数据 JSON；未启用/类型未注册时 `ok:false` + 可读原因
   */
  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const stack = this.stackOf();
    if (stack === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: 'capability 未启用（配置 `capability.enabled` 未开或未生效），无元数据可导出。',
      };
    }
    const requested = call.arguments?.['kind'];
    const kind = typeof requested === 'string' ? requested : undefined;
    const kinds = kind === undefined ? stack.schemas.kinds() : [kind];
    const metadata = kinds
      .map((k) => CapabilityMetadataTool.metadataOf(stack, k))
      .filter((entry): entry is RegistryMetadata => entry !== undefined);
    if (kind !== undefined && metadata.length === 0) {
      return { callId: call.id, ok: false, error: `类型未注册：${kind}` };
    }
    return { callId: call.id, ok: true, output: JSON.stringify(metadata) };
  }

  /**
   * 取某类型的公开元数据（与 CLI `capability metadata` **同源同形**：只有出处在同一处才不会漂移）。
   * @param stack 切片
   * @param kind 类型键
   * @returns 元数据；类型未注册时 undefined
   */
  private static metadataOf(stack: CapabilityStack, kind: string): RegistryMetadata | undefined {
    if (!stack.schemas.has(kind)) return undefined;
    const schema = stack.schemas.schemaOf(kind);
    return {
      kind,
      version: schema.version,
      defaultTrustTier: schema.defaultTrustTier,
      defaultIsolation: schema.defaultIsolation,
      assets: stack.registry.recordsOfKind(kind).map((record) => ({
        name: CapabilityMetadataTool.nameOf(record.asset),
        trustTier: record.governance.trustTier,
        isolation: record.governance.isolation,
        state: record.governance.state,
        operator: record.lineage.operator,
      })),
    };
  }

  /**
   * 取资产名（各类型 `validate` 已保证存在；异常输入退回占位名，不抛）。
   * @param asset 资产本体
   * @returns 资产名
   */
  private static nameOf(asset: unknown): string {
    const name = (asset as { readonly name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : '(anonymous)';
  }
}
