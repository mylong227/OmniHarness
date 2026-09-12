/**
 * I-P3-4 禁闭色荷引擎（Confinement / Color Charge）。
 *
 * 色荷多维约束（色×味×权限×时效），组合合法 = 张量收缩（逐维相加 mod 群阶）得单态(全 0)。
 * 内核把"禁闭"作安全不变量：**裸能力不暴露，只暴露已配对的颜色单态能力**——
 * 比扁平 ACL 权限列表更强，结构上杜绝越权（结构性 fail-closed）。
 */

import type {
  ConfinementPort,
  CapabilityCharge,
  BoundCapability,
  ConfinementVerdict,
  Charge,
} from '../../ports/confinement.js';

export interface ConfinementOptions {
  /** 群阶（默认 3，对应 SU(3) 三色）。 */
  readonly groupOrder?: number;
}

/** 禁闭色荷引擎：实现 {@link ConfinementPort}，以张量收缩判单态、结构性拒绝裸能力暴露。 */
export class ConfinementEngine implements ConfinementPort {
  /** 端口名：禁闭色荷适配器标识，与 ConfinementPort 契约的命名空间一致。 */
  public readonly name = 'confinement';
  /** 群阶（色荷逐维 mod 此值；默认 3，对应 SU(3) 三色）。 */
  public readonly groupOrder: number;

  public constructor(opts: ConfinementOptions = {}) {
    this.groupOrder = opts.groupOrder ?? 3;
  }

  /**
   * 单态校验：色×味×权限×时效四维色荷逐维 mod 群阶后全为 0 才是单态。
   * @param c 带色荷的能力。
   * @returns 是否为颜色单态；裸能力（非全 0）返回 false（结构性拒绝暴露）。
   */
  public isSinglet(c: CapabilityCharge): boolean {
    const g = this.groupOrder;
    return (
      mod(c.charge.color, g) === 0 &&
      mod(c.charge.flavor, g) === 0 &&
      mod(c.charge.permission, g) === 0 &&
      mod(c.charge.expiry, g) === 0
    );
  }

  /**
   * 两能力色荷张量收缩（逐维相加 mod 群阶）：得单态（全 0）→ 束缚能力（id 为
   * `bound:<a.id>+<b.id>`，charge 即收缩后的全 0 色荷）；否则 fail-closed 返回 undefined。
   * @param a 参与束缚的第一能力。
   * @param b 参与束缚的第二能力。
   * @returns 束缚态能力；组合非单态返回 undefined。
   */
  public bind(a: CapabilityCharge, b: CapabilityCharge): BoundCapability | undefined {
    const g = this.groupOrder;
    const combined: Charge = {
      color: mod(a.charge.color + b.charge.color, g),
      flavor: mod(a.charge.flavor + b.charge.flavor, g),
      permission: mod(a.charge.permission + b.charge.permission, g),
      expiry: mod(a.charge.expiry + b.charge.expiry, g),
    };
    // 仅当张量收缩得单态(全 0)才允许暴露；否则 fail-closed 拒绝组合。
    const isSinglet =
      combined.color === 0 &&
      combined.flavor === 0 &&
      combined.permission === 0 &&
      combined.expiry === 0;
    if (!isSinglet) return undefined;
    return { id: `bound:${a.id}+${b.id}`, members: [a.id, b.id], charge: combined };
  }

  /**
   * 暴露裁决：仅单态能力可暴露（exposed=true）；裸能力返回 confined（结构性拒配）。
   * @param c 待裁决的带色荷能力。
   * @returns 裁决结果（是否可暴露 + 理由）。
   */
  public expose(c: CapabilityCharge): ConfinementVerdict {
    if (this.isSinglet(c)) {
      return { id: c.id, exposed: true, reason: 'color-singlet：已配对束缚态，可暴露' };
    }
    return { id: c.id, exposed: false, reason: 'confined：裸能力(非单态)结构性拒配，不暴露' };
  }
}

function mod(n: number, g: number): number {
  return ((n % g) + g) % g;
}
