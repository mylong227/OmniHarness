/**
 * Run Manifest 构建器（纯函数，无 IO）。
 *
 * 只对「工具名排序后的清单」和「提示原文」做哈希，不把提示原文写进清单：
 * 清单会随会话日志落盘并可能被 OTLP 导出，原文进遥测等于把用户输入带到观测后端。
 */
import { createHash } from 'node:crypto';
import { API_VERSION } from '../version.ts';
import type { RunManifest } from '../ports/runtime/runManifest.ts';

/** 构建输入。 */
export interface BuildRunManifestInput {
  /** 工作区根。 */
  readonly workspace: string;
  /** 模型名。 */
  readonly model: string;
  /** 推理强度（可选）。 */
  readonly reasoning?: string | undefined;
  /** 是否只读计划模式。 */
  readonly planMode: boolean;
  /** 工具暴露规划模式（`off` / `plan`）。 */
  readonly exposureMode: 'off' | 'plan';
  /** 本回合可见工具名（调用方传入未排序清单即可）。 */
  readonly tools: readonly string[];
  /** 用户提示原文（只哈希，不存）。 */
  readonly prompt: string;
  /** 清单时间（测试注入受控时钟）。 */
  readonly now?: Date | undefined;
}

/**
 * Run Manifest 构建器。
 */
export class RunManifestBuilder {
  /**
   * 构造清单。
   * @param input 工作区/模型/工具/提示。
   * @returns 不可变清单。
   */
  public static build(input: BuildRunManifestInput): RunManifest {
    const tools = [...new Set(input.tools)].sort();
    return {
      schemaVersion: 1,
      harnessVersion: API_VERSION,
      startedAt: (input.now ?? new Date()).toISOString(),
      workspace: input.workspace,
      model: input.model,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      planMode: input.planMode,
      exposureMode: input.exposureMode,
      toolCount: tools.length,
      toolHash: RunManifestBuilder.sha256(tools.join('\0')),
      toolNames: tools,
      promptHash: RunManifestBuilder.sha256(input.prompt),
      promptChars: input.prompt.length,
    };
  }

  /**
   * 计算 sha256 十六进制。
   * @param text 输入文本。
   * @returns 64 位十六进制。
   */
  private static sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
}
