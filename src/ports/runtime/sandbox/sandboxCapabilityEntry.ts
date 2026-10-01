import type { SandboxProfile } from './sandboxProfile.js';

/** 单个后端的能力自述。 */
export interface SandboxCapabilityEntry {
  /** profile 名（与 `--sandbox` 取值一致）。 */
  readonly profile: SandboxProfile;
  /** 实际承载该 profile 的后端名（用于识别「profile 名 ≠ 实现」的映射）。 */
  readonly backend: string;
  /** 本机是否**真机可达**（不是「代码存在」）。 */
  readonly real: boolean;
  /** 判定依据（平台/二进制/内核探测结论）。 */
  readonly basis: string;
  /** 跑不了时的可执行补救；真机可达时为空串。 */
  readonly actionable: string;
}
