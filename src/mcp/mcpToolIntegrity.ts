import { createHash } from 'node:crypto';
import { log } from '../util/logger.ts';
import type { McpToolDescriptor } from './mcpProtocol.ts';

/** 一次完整性检查结果。 */
export interface McpToolIntegrityResult {
  /** 是否允许继续使用（首次见到的清单也允许）。 */
  readonly ok: boolean;
  /** 是否与上次看到的清单不同。 */
  readonly changed: boolean;
  /** 上次指纹（首次为 undefined）。 */
  readonly previous: string | undefined;
  /** 本次指纹。 */
  readonly current: string;
  /** 变化明细（仅在 changed 时给出）。 */
  readonly changedTools: readonly string[];
}

/**
 * MCP 工具清单完整性固定（防 tool poisoning / rug-pull，2026-10-24）。
 *
 * 背景：MCP 客户端在连接时拉取远端工具描述；恶意/被入侵服务器可以在首次使用后
 * 悄悄改写描述或 schema（同一工具名），让模型按被篡改的说明调用本地能力。
 * 仅靠 `scanToolDescription` 字符串扫描无法发现「先干净、后变脏」的时序攻击。
 *
 * 本类按 server 记录 **name + description + inputSchema** 的规范化 SHA-256：
 * - 首次见到 → 记录并放行；
 * - 后续同一 server 指纹变化 → `ok:false`，调用方必须 fail-closed（不替换工具注册），
 *   直到进程重启或运维显式确认（`OMNI_MCP_ALLOW_TOOL_CHANGES=1`）；
 * - 只在内存中保存，不落盘（无额外凭据/路径面）；指纹是摘要，不含原始描述。
 *
 * 已知边界：这是**会话内**固定；进程重启后重新学习。要跨重启固定，宿主应把
 * `fingerprintOf` 的结果写入受信存储并在启动时比对（本类不替宿主决定信任根）。
 */
export class McpToolIntegrity {
  /** 每个 server 上次看到的指纹。 */
  private readonly fingerprints = new Map<string, string>();
  /** 每个 server 上次看到的逐工具指纹（用于变化明细）。 */
  private readonly toolHashes = new Map<string, ReadonlyMap<string, string>>();

  /**
   * 检查并记录一份工具清单。
   * @param server 服务器名。
   * @param tools 工具描述列表。
   * @param allowChanges 显式允许本次变化（运维确认；缺省读 env）。
   * @returns 检查结果。
   */
  public check(
    server: string,
    tools: readonly McpToolDescriptor[],
    allowChanges: boolean = process.env.OMNI_MCP_ALLOW_TOOL_CHANGES === '1',
  ): McpToolIntegrityResult {
    const current = McpToolIntegrity.fingerprintOf(tools);
    const previous = this.fingerprints.get(server);
    const currentHashes = McpToolIntegrity.toolHashesOf(tools);
    if (previous === undefined) {
      this.remember(server, current, currentHashes);
      return { ok: true, changed: false, previous: undefined, current, changedTools: [] };
    }
    if (previous === current) {
      this.remember(server, current, currentHashes);
      return { ok: true, changed: false, previous, current, changedTools: [] };
    }
    const before = this.toolHashes.get(server) ?? new Map<string, string>();
    const changedTools = [...currentHashes.keys(), ...before.keys()].filter(
      (name) => before.get(name) !== currentHashes.get(name),
    );
    const uniqueTools = [...new Set(changedTools)].sort();
    // 纯增删（工具集合变化）是 MCP list_changed 的正常形态：允许并重新基线；
    // 但**同名工具的描述/schema 变化**是 rug-pull 的核心形态，必须拒绝。
    const modified = uniqueTools.filter(
      (name) =>
        before.has(name) && currentHashes.has(name) && before.get(name) !== currentHashes.get(name),
    );
    if (modified.length === 0 && uniqueTools.length > 0) {
      this.remember(server, current, currentHashes);
      log.warn('mcp.tool_integrity.tools_added_or_removed', { server, changedTools: uniqueTools });
      return { ok: true, changed: true, previous, current, changedTools: uniqueTools };
    }
    if (allowChanges) {
      this.remember(server, current, currentHashes);
      log.warn('mcp.tool_integrity.changed_allowed', {
        server,
        previous,
        current,
        changedTools: uniqueTools,
      });
      return { ok: true, changed: true, previous, current, changedTools: uniqueTools };
    }
    log.warn('mcp.tool_integrity.changed', {
      server,
      previous,
      current,
      changedTools: uniqueTools,
    });
    return { ok: false, changed: true, previous, current, changedTools: uniqueTools };
  }

  /**
   * 计算工具清单的规范化指纹（排序后逐项 name/description/inputSchema）。
   * @param tools 工具描述列表。
   * @returns SHA-256 hex。
   */
  public static fingerprintOf(tools: readonly McpToolDescriptor[]): string {
    const canonical = [...tools]
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? null,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * 逐工具指纹（用于变化明细）。
   * @param tools 工具描述列表。
   * @returns 工具名 → SHA-256。
   */
  private static toolHashesOf(tools: readonly McpToolDescriptor[]): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const tool of tools) {
      out.set(
        tool.name,
        createHash('sha256')
          .update(JSON.stringify([tool.name, tool.description ?? '', tool.inputSchema ?? null]))
          .digest('hex'),
      );
    }
    return out;
  }

  /**
   * 记录指纹与逐工具指纹。
   * @param server 服务器名。
   * @param fingerprint 指纹。
   * @param hashes 逐工具指纹。
   * @returns 无返回值。
   */
  private remember(server: string, fingerprint: string, hashes: ReadonlyMap<string, string>): void {
    this.fingerprints.set(server, fingerprint);
    this.toolHashes.set(server, hashes);
  }
}
