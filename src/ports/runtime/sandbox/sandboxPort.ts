import type { SandboxAction } from './sandboxAction.ts';
import type { SandboxDecision } from './sandboxDecision.ts';

/** 沙箱端口：命令/文件访问的统一插口（可换本地/OS级/远程沙箱）。 */
export interface SandboxPort {
  readonly name: string;
  check(action: SandboxAction): Promise<SandboxDecision>;
  /**
   * 把一条 shell 命令包装成在 OS 沙箱内执行的命令文本（可选）。
   *
   * 只有真正接了执行包装的后端才实现；未实现 = 该 profile 只能裁决、不能隔离，
   * 调用方（CLI）必须 fail-closed，不能把“选了 bwrap”当成已隔离。
   * @param command 原始命令文本
   * @param cwd 命令工作目录（沙箱可写 bind 的基准）
   * @returns 包装后的命令文本
   */
  wrapCommand?(command: string, cwd: string): string;
}
