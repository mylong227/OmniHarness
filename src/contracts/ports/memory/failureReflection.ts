/**
 * 失败反思记忆端口（P2 · Reflexion 式经验复用）。
 *
 * 与长期记忆的区别：这里存的是**某次自验证失败的结构化教训**（工具/文件/退出码/摘要），
 * 只用于同一工作区的后续写操作提示，不进入面向用户的事实记忆，也不作为“已验证”证据。
 */

/** 一条失败反思。 */
export interface FailureReflection {
  /** 稳定 id（同内容去重前由存储生成）。 */
  readonly id: string;
  /** 触发失败的工具名。 */
  readonly toolName: string;
  /** 本次改动涉及的工作区相对路径。 */
  readonly targets: readonly string[];
  /** 当时执行的测试命令（可为空串：未跑测试的失败不记录）。 */
  readonly command: string;
  /** 退出码（超时/未执行时为 null）。 */
  readonly exitCode: number | null;
  /** 失败摘要（已裁剪；不是原始全量输出）。 */
  readonly digest: string;
  /** 记录时间（ISO）。 */
  readonly at: string;
}

/** 失败反思端口（可注入内存/文件实现）。 */
export interface FailureReflectionPort {
  /**
   * 记录一条失败反思（同工具 + 同目标 + 同退出码 + 同摘要前缀视为重复，不重复写）。
   * @param input 除 id/at 外的反思内容
   * @returns 无返回值
   */
  remember(input: Omit<FailureReflection, 'id' | 'at'>): Promise<void>;

  /**
   * 召回与目标文件重叠的最近失败反思。
   * @param input 目标文件（工作区相对路径）与条数上限
   * @returns 最近的反思（无重叠时为空）
   */
  recall(input: {
    readonly targets: readonly string[];
    readonly limit?: number;
  }): Promise<readonly FailureReflection[]>;
}
