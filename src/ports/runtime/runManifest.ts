/**
 * 运行清单（Run Manifest）：一次会话「到底跑了什么配置」的可复核快照。
 *
 * 为什么需要：评测结论必须能回答「这次是哪个模型、哪套工具、什么提示、什么模式」；
 * 没有它，harness 变更前后的差异无法解释，也无法复现。清单写入 `session_meta`，
 * 与事件流同源；OTLP 侧由 `TraceSpanBuilder` 投影为 `invoke_agent` span。
 */
export interface RunManifest {
  /** 清单结构版本（升级字段时 bump，旧日志仍可读）。 */
  readonly schemaVersion: 1;
  /** harness API 版本锚。 */
  readonly harnessVersion: string;
  /** 清单生成时间（ISO）。 */
  readonly startedAt: string;
  /** 工作区根（归一化）。 */
  readonly workspace: string;
  /** 模型名（适配器报告的 name）。 */
  readonly model: string;
  /** 推理强度（未配置时省略）。 */
  readonly reasoning?: string | undefined;
  /** 是否只读计划模式。 */
  readonly planMode: boolean;
  /** 工具暴露规划模式（`off` 全量 / `plan` 按需）。 */
  readonly exposureMode: 'off' | 'plan';
  /** 本回合注册工具数（含 deferred；工具暴露规划在请求期生效，故不是"最终可见数"）。 */
  readonly toolCount: number;
  /** 工具名排序后的 sha256（跨机器可比；不泄漏参数）。 */
  readonly toolHash: string;
  /** 工具名清单（排序；用于人工复核与差异定位）。 */
  readonly toolNames: readonly string[];
  /** 用户提示原文的 sha256（不落原文，避免敏感内容进遥测）。 */
  readonly promptHash: string;
  /** 提示字符数（用于区分空提示/长任务）。 */
  readonly promptChars: number;
}
