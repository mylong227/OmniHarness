/**
 * 沙箱拒绝归因（G3 核心）——**实现**侧。
 *
 * 位置沿革：`adapters/sandbox/denial.ts` →（P1 解耦，`c9509ba`）`ports/runtime/sandboxDenial.ts`
 * →（2026-09-26，本仓「非 UI .ts 一律 class 实现」口径）实现体迁出 ports：
 * `src/ports/**` 的架构门禁（ports 纯度）**禁止 class 实现**，只放契约与类型，
 * 故类实现落在这里，`ports/runtime/sandboxDenial.ts` 只保留 `RuntimeFailure` 契约。
 * 纯领域逻辑、零适配器依赖（仍然可被 core 直接消费）。
 */
import type { SandboxDenialCategory } from '../ports/runtime/sandbox.js';
import type { RuntimeFailure } from '../ports/runtime/sandboxDenial.js';

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

/**
 * 沙箱拒绝归因：判定「失败是否由沙箱拒绝导致」并归类。
 */
export class SandboxDenial {
  /**
   * 判断运行时错误是否 likely 由沙箱拒绝导致（G3 核心：识别沙箱违规而非一般错误）。
   * 用于执行期 OS 级沙箱（如 RestrictedToken / Landlock）kill 进程后的归因。
   * @param failure 运行时失败形状（兼容 child_process / node:fs 抛错）。
   * @returns 命中拒绝签名或终止信号为 SIGSYS/SIGKILL 时为 true。
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

  /**
   * 归类拒绝原因（网络/OS/其他），驱动升级审批与可观测性（路径越界/危险命令由 SandboxDecision.category 提供）。
   * @param failure 运行时失败形状。
   * @returns 拒绝类别：`network` / `os` / `other`。
   */
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
