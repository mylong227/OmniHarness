import type { SandboxPort } from '../../ports/runtime/sandbox.js';
import { PassthroughSandbox } from './passthroughSandbox.js';
import { PolicySandbox } from './policySandbox.js';
import { RestrictedSandbox } from './restrictedSandbox.js';
import { UnsupportedSandbox } from './unsupportedSandbox.js';
import { LinuxBwrapSandbox } from './linuxBwrapSandbox.js';
import { LinuxUnshareSandbox } from './linuxUnshareSandbox.js';
import { LinuxLandlockSandbox } from './linuxLandlockSandbox.js';
import { MacOsSeatbeltSandbox } from './macosSeatbeltSandbox.js';

/** 沙箱后端 profile 名（G4 多后端切换）。 */
export type SandboxProfile =
  'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap' | 'unshare';

/**
 * 沙箱多后端注册表（G4）：按 profile 名选后端，新后端即插即用。
 *
 * 映射纪律（审计整改）：profile 名必须**如实对应能力**，不得把 `landlock` 偷偷换成 `bwrap`——
 * 前者是内核态路径 ACL、后者是用户态命名空间，二者语义不同，谎称一致会让「以为开了 landlock」
 * 的使用者实际拿到 bwrap 行为。故：
 * - `bwrap` → LinuxBwrapSandbox（真实的 bwrap 用户态命名空间后端）；
 * - `unshare` → LinuxUnshareSandbox（真实的 `unshare -rm` 内核命名空间后端）；
 * - `landlock` → LinuxLandlockSandbox（**严格探测**内核 Landlock 可见性 + 内核版本 +
 *   `OMNI_LANDLOCK_HELPER` 指向的 helper；任一不成立即 fail-closed，不冒充其它后端，也不谎称已隔离）；
 * - `seatbelt` → MacOsSeatbeltSandbox（非 macOS 恒 fail-closed）。
 *
 * 「本机到底哪个后端真能跑、依据是什么」由 {@link SandboxCapabilityTable} 统一自述，
 * 并经 `omniharness doctor` 输出——实现存在但无真机证据这件事从此可见、可复现。
 */
export class SandboxManager {
  /** 后端注册表：profile 名 → 工厂（延迟实例化）。 */
  private readonly backends = new Map<SandboxProfile, () => SandboxPort>();

  /**
   * @param workspaceRoot 工作区根目录（传给各策略后端作为路径白名单基准）。
   */
  public constructor(private readonly workspaceRoot: string) {
    this.register('passthrough', () => new PassthroughSandbox());
    this.register('policy', () => new PolicySandbox({ workspaceRoot: this.workspaceRoot }));
    this.register('restricted', () => new RestrictedSandbox({ workspaceRoot: this.workspaceRoot }));
    this.register('landlock', () => new LinuxLandlockSandbox(this.workspaceRoot));
    this.register('bwrap', () => new LinuxBwrapSandbox(this.workspaceRoot));
    this.register('unshare', () => new LinuxUnshareSandbox(this.workspaceRoot));
    this.register('seatbelt', () => new MacOsSeatbeltSandbox(this.workspaceRoot));
  }

  /** 注册后端（工厂延迟实例化，避免无谓构造）。
   * @param profile 沙箱 profile 名。
   * @param factory 后端工厂函数。
   * @returns 无返回值。
   */
  public register(profile: SandboxProfile, factory: () => SandboxPort): void {
    this.backends.set(profile, factory);
  }

  /**
   * 按 profile 构建沙箱端口。
   *
   * 未知 profile 返回 `UnsupportedSandbox`（一律拒绝 + `category: 'os'`），
   * **绝不回退 PassthroughSandbox**——回退直通等于把「拼错 profile 名」静默变成
   * 「全量放行」，是 fail-open。安全操作宁可拒绝也不放行（项目 fail-closed 铁律）。
   * @param profile 要构建的沙箱 profile 名。
   * @returns 对应的沙箱端口；未知 profile 返回 UnsupportedSandbox（fail-closed）。
   */
  public build(profile: SandboxProfile): SandboxPort {
    const factory = this.backends.get(profile);
    if (factory === undefined) {
      return new UnsupportedSandbox(profile, `未知沙箱 profile: ${String(profile)}`);
    }
    return factory();
  }
}
