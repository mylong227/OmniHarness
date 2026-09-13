import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';

/**
 * 不支持的 OS 级沙箱后端占位（G4）：本平台无对应内核 API 时注册，
 * fail-closed 拒绝并说明原因——绝不谎称已隔离（审计明确 Landlock/seatbelt/bwrap 本环境不适用）。
 */
export class UnsupportedSandbox implements SandboxPort {
  /** 适配器名（端口契约），取构造传入的 profile 名。 */
  public readonly name: string;

  public constructor(
    profileName: string,
    private readonly reason: string,
  ) {
    this.name = profileName;
  }

  /** 一律拒绝，附平台不支持原因。
   * @param _action 沙箱动作（占位后端不做裁决区分，忽略）。
   * @returns 恒为 `{ allowed: false }`（fail-closed，类别 'os'）。
   */
  public async check(_action: SandboxAction): Promise<SandboxDecision> {
    return { allowed: false, reason: `平台不支持的沙箱后端: ${this.reason}`, category: 'os' };
  }
}
