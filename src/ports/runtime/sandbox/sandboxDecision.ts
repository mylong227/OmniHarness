import type { SandboxDenialCategory } from './sandboxDenialCategory.js';

/** 沙箱裁决。 */
export interface SandboxDecision {
  readonly allowed: boolean;
  /** 拒绝原因（拒绝时必填）。 */
  readonly reason?: string;
  /** 拒绝归类（G3）：路径越界/危险命令/网络/OS/其他，便于升级审批分流。 */
  readonly category?: SandboxDenialCategory;
}
