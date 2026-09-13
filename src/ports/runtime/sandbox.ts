/** 沙箱动作类型。 */
export type SandboxActionKind = 'command' | 'file_read' | 'file_write';

/** 沙箱拒绝归类（G3：用于升级审批与可观测性归因）。 */
export type SandboxDenialCategory = 'path' | 'command' | 'network' | 'os' | 'other';

/** 沙箱待裁决动作。 */
export interface SandboxAction {
  readonly kind: SandboxActionKind;
  readonly target: string;
}

/** 沙箱裁决。 */
export interface SandboxDecision {
  readonly allowed: boolean;
  /** 拒绝原因（拒绝时必填）。 */
  readonly reason?: string;
  /** 拒绝归类（G3）：路径越界/危险命令/网络/OS/其他，便于升级审批分流。 */
  readonly category?: SandboxDenialCategory;
}

/** 沙箱端口：命令/文件访问的统一插口（可换本地/OS级/远程沙箱）。 */
export interface SandboxPort {
  readonly name: string;
  check(action: SandboxAction): Promise<SandboxDecision>;
}
