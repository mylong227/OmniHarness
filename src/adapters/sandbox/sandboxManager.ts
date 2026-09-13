import type { SandboxPort } from '../../ports/runtime/sandbox.js';
import { PassthroughSandbox } from './passthroughSandbox.js';
import { PolicySandbox } from './policySandbox.js';
import { RestrictedSandbox } from './restrictedSandbox.js';
import { UnsupportedSandbox } from './unsupportedSandbox.js';
import { LinuxBwrapSandbox } from './linuxBwrapSandbox.js';
import { MacOsSeatbeltSandbox } from './macosSeatbeltSandbox.js';

/** 沙箱后端 profile 名（G4 多后端切换）。 */
export type SandboxProfile =
  'passthrough' | 'policy' | 'restricted' | 'landlock' | 'seatbelt' | 'bwrap';

/**
 * 沙箱多后端注册表（G4）：按 profile 名选后端，新后端即插即用。
 * 本环境（Windows）不支持的 OS 级后端（landlock/seatbelt/bwrap）注册为
 * fail-closed 占位，避免谎称已隔离——与审计「Seatbelt/Landlock/bwrap 本环境不适用」一致。
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
    this.register('landlock', () => new LinuxBwrapSandbox(this.workspaceRoot));
    this.register('bwrap', () => new LinuxBwrapSandbox(this.workspaceRoot));
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
