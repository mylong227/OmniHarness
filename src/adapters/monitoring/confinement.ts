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

export class ConfinementEngine implements ConfinementPort {
  readonly name = 'confinement';
  readonly groupOrder: number;

  constructor(opts: ConfinementOptions = {}) {
    this.groupOrder = opts.groupOrder ?? 3;
  }

  isSinglet(c: CapabilityCharge): boolean {
    const g = this.groupOrder;
    return (
      mod(c.charge.color, g) === 0 &&
      mod(c.charge.flavor, g) === 0 &&
      mod(c.charge.permission, g) === 0 &&
      mod(c.charge.expiry, g) === 0
    );
  }

  bind(a: CapabilityCharge, b: CapabilityCharge): BoundCapability | undefined {
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

  expose(c: CapabilityCharge): ConfinementVerdict {
    if (this.isSinglet(c)) {
      return { id: c.id, exposed: true, reason: 'color-singlet：已配对束缚态，可暴露' };
    }
    return { id: c.id, exposed: false, reason: 'confined：裸能力(非单态)结构性拒配，不暴露' };
  }
}

function mod(n: number, g: number): number {
  return ((n % g) + g) % g;
}
