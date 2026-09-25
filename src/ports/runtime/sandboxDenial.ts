import type { SandboxDenialCategory } from './sandbox.js';

/**
 * SandboxDenial —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class SandboxDenial {
  /**
   * 判断运行时错误是否 likely 由沙箱拒绝导致（G3 核心：识别沙箱违规而非一般错误）。
   * 用于执行期 OS 级沙箱（如 RestrictedToken / Landlock）kill 进程后的归因。
   */
  public static isLikelySandboxDenied(failure: RuntimeFailure): boolean {
    const text = `${failure.stderr ?? ''}\n${failure.message ?? ''}`;
    if (SANDBOX_DENIAL_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }
    // 信号级强杀：沙箱常以 SIGSYS（seccomp）或 SIGKILL 拒绝。
    if (failure.signal === 'SIGSYS' || failure.signal === 'SIGKILL') {
      return true;
    }
    return false;
  }

  /** 归类拒绝原因（网络/OS/其他），驱动升级审批与可观测性（路径越界/危险命令由 SandboxDecision.category 提供）。 */
  public static classifyDenial(failure: RuntimeFailure): SandboxDenialCategory {
    const text = `${failure.stderr ?? ''}\n${failure.message ?? ''}`;
    if (NETWORK_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'network';
    }
    if (SANDBOX_DENIAL_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'os';
    }
    if (failure.signal === 'SIGSYS' || failure.signal === 'SIGKILL') {
      return 'os';
    }
    return 'other';
  }
}

/**
 * 沙箱拒绝归因（G3 核心）：纯领域逻辑，零适配器依赖，置于 ports 层供 core 直接消费。
 * 原位于 adapters/sandbox/denial.ts，因仅依赖 ports 且被 core/stepRunner 消费，P1 解耦时上移到 ports。
 */

/** OS 沙箱拒绝的典型签名（stderr/信息关键字）。移植自 Codex sandboxing/src/denial.rs 思路。 */
const SANDBOX_DENIAL_PATTERNS: readonly RegExp[] = [
  /operation not permitted/i,
  /permission denied/i,
  /access is denied/i,
  /eacces/i,
  /sandbox/i,
  /seccomp/i,
  /ptrace denied/i,
  /text file busy/i, // ETXTBSY
];

/** 网络外联类拒绝签名（用于归类）。 */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /econnrefused/i,
  /network is unreachable/i,
  /name or service not known/i,
  /getaddrinfo/i,
  /curl: \(\d+\)/i,
];

/** 运行时失败形状（兼容 child_process / node:fs 抛错）。 */
export interface RuntimeFailure {
  /** 退出码。 */
  readonly code?: string | number;
  /** 终止信号。 */
  readonly signal?: string | number;
  /** 标准错误输出。 */
  readonly stderr?: string;
  /** 错误消息。 */
  readonly message?: string;
}
