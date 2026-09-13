import type { GraphSummary } from '../autonomy/graphStore.js';
import type { PluginManifest } from '../plugin/manifest.js';
import { BUILTIN_AGENT_PERSONAS } from '../subagent/agentPersonas.js';

/** 智能体目录条目的来源类型。 */
export type AgentKind = 'builtin' | 'graph' | 'plugin';

/** 智能体目录条目（UI「+ → 智能体」列表项，选中后由前端合成回合指令）。 */
export interface AgentCatalogEntry {
  /** 唯一 id（`<kind>:<raw>`，避免不同来源重名互撞）。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** 来源类型。 */
  readonly kind: AgentKind;
  /** 一句话说明。 */
  readonly description: string;
  /** 选中后要追加给模型的角色指令（编排图 / 插件来源为 undefined，改为附路径指引）。 */
  readonly directive?: string;
}

/** 智能体目录依赖。 */
export interface AgentCatalogDeps {
  /** 已保存的多 Agent 编排图（`WorkflowGraphStore.list`）。 */
  readonly graphs: () => readonly GraphSummary[];
  /** 已安装插件清单（`PluginRegistry.list`，异步——市场注册表读取磁盘）。 */
  readonly plugins: () => Promise<readonly PluginManifest[]>;
}

/**
 * 智能体目录服务：把「可选的干活角色」聚成一份清单供 UI 的「+ → 智能体」使用。
 *
 * 三类来源各自诚实标注（`kind`），因为它们的能力边界完全不同，混成一锅会让用户误判：
 *  - `builtin`——内置角色：只是提示词层面的关注点切换，不派生进程、不改工具集；
 *  - `graph`——编排图：真会派生多节点并行执行，选中意味着下一轮任务按该 DAG 跑；
 *  - `plugin`——插件贡献的角色/工具：能力由插件声明与 `PermissionGate` 决定。
 *
 * 任何来源取数失败都降级为空数组（面板少一行，好过整块报错）——毕竟这只是个选择列表。
 */
export class AgentCatalogService {
  /**
   * @param deps 编排图与插件两个取数器
   */
  public constructor(private readonly deps: AgentCatalogDeps) {}

  /**
   * 列出全部可选智能体。
   * @returns `{ agents }`：内置角色在前的合并清单
   */
  public async list(): Promise<{ agents: readonly AgentCatalogEntry[] }> {
    return {
      agents: [...this.builtins(), ...this.graphAgents(), ...(await this.pluginAgents())],
    };
  }

  /**
   * 内置角色（提示词层面）。
   * @returns 全部内置角色的目录条目（id 前缀 `builtin:`）
   */
  private builtins(): AgentCatalogEntry[] {
    return BUILTIN_AGENT_PERSONAS.map((persona) => ({
      id: 'builtin:' + persona.id,
      name: persona.name,
      kind: 'builtin' as const,
      description: persona.description,
      directive: persona.directive,
    }));
  }

  /**
   * 已保存的编排图（真多节点执行）。
   * @returns 编排图来源的目录条目（id 前缀 `graph:`）；取数失败降级为空数组
   */
  private graphAgents(): AgentCatalogEntry[] {
    try {
      return this.deps.graphs().map((graph) => ({
        id: 'graph:' + graph.id,
        name: graph.name,
        kind: 'graph' as const,
        description: `编排图 · ${graph.stepCount} 个节点（选中后本轮按该 DAG 执行）`,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 已安装插件。
   * @returns 插件来源的目录条目（id 前缀 `plugin:`）；取数失败降级为空数组
   */
  private async pluginAgents(): Promise<AgentCatalogEntry[]> {
    try {
      const plugins = await this.deps.plugins();
      return plugins.map((plugin) => ({
        id: 'plugin:' + plugin.name,
        name: plugin.name,
        kind: 'plugin' as const,
        description: plugin.description ?? `插件 v${plugin.version}`,
      }));
    } catch {
      return [];
    }
  }
}
