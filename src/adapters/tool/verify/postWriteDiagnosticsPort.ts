/**
 * 写后自动诊断回灌装饰器（P1-⑦ 后半）。
 *
 * 补齐的口子：`lsp_diagnostics` 工具已在（模型**主动**可查），但盘点指出还差
 * 「**写后自动**诊断回灌」——即模型改完源码**不必记得**去查，系统在同一步就把编译/类型错误
 * 摆到它面前。这正是成熟同类（Codex / Claude Code）默认行为的核心一环。
 *
 * 为什么做成 `ToolPort` 装饰器：与 `SelfVerifyingToolPort` 同样取向——**零热区改动**、
 * 组合根一处装配即生效、不装配即零行为。
 *
 * 噪声纪律（避免把回灌变成刷屏）：
 * - 只对**写类工具 + 源码扩展名**的目标跑诊断（复用 {@link SelfVerifyPolicy.isVerifiableTarget}）；
 * - 只在出现 **error 级**诊断时回灌（warning/info 不打扰模型，它自己需要时可用 `lsp_diagnostics`）；
 * - `stale` 报告**不回灌**（那只是一段「没等到」的不确定提示，写后每次都贴纯属噪声）；
 * - 单次最多检查 {@link MAX_CHECKED_FILES} 个文件（多文件补丁不至于刷满上下文）；
 * - **fail-open**：诊断抛错/超时一律不影响原工具结果（这是质量信号，不是安全边界）。
 */
import { resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { LspDiagnosticReport } from '../../../ports/tool/lsp.js';
import { LspDiagnosticsRenderer } from '../lsp/lspDiagnosticsRenderer.js';
import { MutationTargets } from './mutationTargets.js';
import { SelfVerifyPolicy } from './selfVerifyPolicy.js';

/** 单次最多检查的目标文件数。 */
const MAX_CHECKED_FILES = 3;

/** 装饰器装配项（全部由组合根注入）。 */
export interface PostWriteDiagnosticsWiring {
  /** 工作区根（把相对目标解析为绝对路径，LSP 端口按绝对路径取诊断）。 */
  readonly workspaceRoot: string;
  /** 诊断取值（生产为 `LspPort.diagnostics` 绑定）。 */
  readonly diagnostics: (absoluteFile: string) => Promise<LspDiagnosticReport>;
  /** 触发器：该工具调用是否应触发写后诊断（由组合根按写类工具 + 源码扩展名判定）。 */
  readonly shouldCheck: (toolName: string, args: Readonly<Record<string, unknown>>) => boolean;
}

/**
 * 写后自动诊断回灌装饰器：透明转发 `ToolPort` 全部方法，仅在「写源码」调用后追加诊断。
 */
export class PostWriteDiagnosticsPort implements ToolPort {
  /** 端口名（透传内层，保持审批/日志中的标识不变）。 */
  public readonly name: string;

  /** 被装饰的内层端口。 */
  private readonly inner: ToolPort;
  /** 装配项。 */
  private readonly wiring: PostWriteDiagnosticsWiring;

  /**
   * @param inner 被装饰的工具端口（生产为 `RegistryToolPort` 或自验证装饰器）。
   * @param wiring 装配项（诊断取值 + 触发器 + 工作区根）。
   */
  public constructor(inner: ToolPort, wiring: PostWriteDiagnosticsWiring) {
    this.inner = inner;
    this.wiring = wiring;
    this.name = inner.name;
  }

  /**
   * 全部工具定义（透传）。
   *
   * @returns 内层端口的工具定义列表。
   */
  public list(): readonly ToolDefinition[] {
    return this.inner.list();
  }

  /**
   * 供模型上下文的工具子集（透传）。
   *
   * @returns 内层端口的非 deferred 工具定义列表。
   */
  public listDirect(): readonly ToolDefinition[] {
    return this.inner.listDirect?.() ?? this.inner.list();
  }

  /**
   * 反注册工具（透传）。
   *
   * @param name 要反注册的工具名。
   * @returns 内层删除成功时为 true。
   */
  public unregister(name: string): boolean {
    return this.inner.unregister?.(name) ?? false;
  }

  /**
   * 执行工具调用，并在「写源码成功」后追加错误级诊断。
   *
   * @param call 工具调用（参数里含写入目标路径）。
   * @param context 工具上下文（透传给内层）。
   * @returns 内层结果；写后若发现 error 级诊断，`output` 追加诊断段。
   */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const result = await this.inner.execute(call, context);
    if (!result.ok || !this.wiring.shouldCheck(call.name, call.arguments)) {
      return result;
    }
    const note = await this.collect(call);
    if (note === undefined) {
      return result;
    }
    const output = result.output === undefined ? note : `${result.output}\n\n${note}`;
    return { ...result, output };
  }

  /**
   * 对本次改动的源码目标取诊断，拼出（仅在确有 error 时的）回灌文本。
   *
   * @param call 本次工具调用（用于解析目标路径）。
   * @returns 回灌文本；无 error 级诊断或全部取数失败时为 `undefined`。
   */
  private async collect(call: ToolCall): Promise<string | undefined> {
    const targets = PostWriteDiagnosticsPort.targetsOf(call, this.wiring.workspaceRoot);
    const sections: string[] = [];
    for (const target of targets.slice(0, MAX_CHECKED_FILES)) {
      const report = await this.diagnose(target);
      if (report === undefined || !LspDiagnosticsRenderer.hasErrors(report)) {
        continue;
      }
      sections.push(LspDiagnosticsRenderer.render(report));
    }
    if (sections.length === 0) {
      return undefined;
    }
    return `[写后诊断] 本次改动引入了编译/类型错误（自动来自 LSP，无需再跑构建）：\n${sections.join('\n')}`;
  }

  /**
   * 取一次诊断（fail-open：端口缺失实现或抛错都视为「无信息」）。
   *
   * @param absoluteFile 目标文件绝对路径。
   * @returns 诊断报告；取数失败时为 `undefined`。
   */
  private async diagnose(absoluteFile: string): Promise<LspDiagnosticReport | undefined> {
    try {
      return await this.wiring.diagnostics(absoluteFile);
    } catch {
      return undefined;
    }
  }

  /**
   * 解析本次调用应检查的**绝对**源码路径清单。
   *
   * @param call 工具调用。
   * @param workspaceRoot 工作区根。
   * @returns 去重后的绝对路径（仅源码扩展名）；无目标时为空数组。
   */
  private static targetsOf(call: ToolCall, workspaceRoot: string): readonly string[] {
    const absolute: string[] = [];
    for (const target of MutationTargets.of(call.name, call.arguments)) {
      if (!SelfVerifyPolicy.isVerifiableTarget(target)) {
        continue;
      }
      const resolved = resolve(workspaceRoot, target);
      if (!absolute.includes(resolved)) {
        absolute.push(resolved);
      }
    }
    return absolute;
  }
}
