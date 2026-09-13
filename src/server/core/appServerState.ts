import type { ApprovalPort } from '../../ports/runtime/approval.js';
import type { ResolvedConfig } from '../../config/configFactory.js';
import type { SkillRegistry } from '../../skill/skillRegistry.js';
import type { PluginRegistry } from '../../plugin/pluginRegistry.js';
import type { Transport } from '../transport/lineTransport.js';
import type { Metrics } from '../services/metrics.js';
import type { AuditSink } from '../services/auditSink.js';
import type { GraphNodeStatus } from '../../autonomy/workflowRunner.js';

/** AppServer 选项。 */
export interface AppServerOptions {
  readonly config: ResolvedConfig;
  readonly transport: Transport;
  readonly skills?: SkillRegistry;
  readonly approvalUplink?: boolean;
  readonly metrics?: Metrics;
  /** 插件注册表（注入后暴露 plugins.list / plugins.search，供 UI 市场视图）。 */
  readonly registry?: PluginRegistry;
  /** 插件安装目录（注入后启动时自动加载已安装插件进 Agent 工具表；闭环 G-B）。 */
  readonly pluginsDir?: string;
  /** 可读配置摘要（字符串标识，供 UI 设置面板展示；不暴露端口对象）。 */
  readonly displayConfig?: Record<string, string>;
  /** 服务端自动审批（免客户端上行；UI 可经 config.update 切换）。 */
  readonly autoApprove?: boolean;
  /** 持久化目标配置文件路径（项目级 omniharness.json；缺省时按工作区推断并创建）。 */
  readonly configPath?: string;
  /** 工作区根（检查点文件快照还原用；缺省回退 process.cwd()）。 */
  readonly workspaceRoot?: string;
  /**
   * 是否允许模型目录覆盖启动模型（读落盘 omniharness.json / UI 覆盖 / 环境凭据构造真适配器）。
   * 缺省 true（serve 模式依赖此行为热切换真模型）；嵌入方与单测注入 mock 模型时
   * 必须显式传 false——否则测试会读到开发者本机配置，拿真实凭据打真实 API。
   */
  readonly modelOverrideEnabled?: boolean;
  /** 结构化审计日志 sink（注入后所有事件落盘 JSONL；未注入则无审计）。 */
  readonly audit?: AuditSink;
}

/** 始终放行的审批端口（autoApprove / approval=auto 时使用）。 */
export const AUTO_ALLOW: ApprovalPort = { name: 'auto', decide: () => Promise.resolve('allow') };

/** 始终拒绝的审批端口（approval=deny 时使用）。 */
export const DENY_ALL: ApprovalPort = { name: 'deny', decide: () => Promise.resolve('deny') };

/** 默认档审批端口（UI 切到 rules 且原配置非 rules 时回退用：放行常规工具，危险操作由沙箱层兜底）。 */
export const RULES_DEFAULT: ApprovalPort = {
  name: 'rules',
  decide: () => Promise.resolve('allow'),
};

/**
 * config.update 允许持久化到配置文件的字段。
 * apiKey/providerKeys 可经此通道写入（落盘本地 omniharness.json，与手改文件等价），
 * 但 config.get 回传一律打码——凭据原文永不返回 UI，防泄露。
 * workspace/mcpServers 仍不由此通道写入（防篡改工作区与 MCP 面）。
 */
export const PERSISTABLE_KEYS: readonly string[] = [
  'modelAdapter',
  'model',
  'baseUrl',
  'apiKey',
  'providerKeys',
  'storageAdapter',
  'storageDir',
  'approval',
  'reasoning',
  'sandbox',
  'escalation',
  'elevatedSandbox',
  'maxSteps',
];

/** 图运行中单节点状态。 */
interface GraphRunNodeState {
  readonly id: string;
  status: GraphNodeStatus;
  error?: string;
  steps?: number;
  durationMs?: number;
}

/** 图运行态（runId → 此结构），graph.status 返回其快照。 */
export interface GraphRunState {
  readonly runId: string;
  readonly defId?: string;
  readonly defName?: string;
  readonly nodes: Record<string, GraphRunNodeState>;
  done: boolean;
  ok?: boolean;
  blackboard?: Readonly<Record<string, string>>;
  readonly startedAt: number;
}
