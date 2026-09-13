/**
 * I-P3-4 禁闭色荷端口（Confinement / Color Charge）端口。
 *
 * Wilson 1974 PRD 10:2445 禁闭强绑定：色荷不可孤立，只以**无色束缚态（单态）**存在。
 * 内核把"禁闭"作安全不变量——**裸能力不暴露，只暴露已配对的"颜色单态"能力**。
 * 比扁平 ACL 权限列表更强：结构性杜绝越权（裸能力在结构上无法被暴露）。
 *
 * 色荷多维约束（Greenberg 1964 / Han-Nambu 1965）：(色×味×权限×时效) 多维标签，
 * 组合合法 = 张量收缩（逐维相加 mod 群阶）得单态（全 0）。跨维度须同时满足的复合约束。
 *
 * fail-closed：非单态能力 → expose 返回 confined（拒配）；bind 非单态组合 → undefined。
 */

/** 多维色荷（整数群元素，运行时 mod 群阶）。 */
export interface Charge {
  /** 色。 */
  readonly color: number;
  /** 味。 */
  readonly flavor: number;
  /** 权限。 */
  readonly permission: number;
  /** 时效。 */
  readonly expiry: number;
}

/** 带色荷的能力。 */
export interface CapabilityCharge {
  /** 能力 ID。 */
  readonly id: string;
  /** 多维色荷。 */
  readonly charge: Charge;
}

/** 两能力束缚后的单态能力。 */
export interface BoundCapability {
  /** 束缚态 ID。 */
  readonly id: string;
  /** 成员能力 ID 序列。 */
  readonly members: readonly string[];
  /** 束缚态色荷（必为单态：全 0）。 */
  readonly charge: Charge;
}

/** 暴露裁决。 */
export interface ConfinementVerdict {
  /** 能力 ID。 */
  readonly id: string;
  /** 是否可暴露（仅单态为 true）。 */
  readonly exposed: boolean;
  /** 理由。 */
  readonly reason: string;
}

/** 禁闭色荷端口。 */
export interface ConfinementPort {
  /** 群阶（色荷 mod 此值；默认 3，对应 SU(3) 三色）。 */
  readonly groupOrder: number;
  /**
   * 两能力色荷张量收缩（逐维相加 mod 群阶）；得单态(全 0)→束缚能力可暴露，
   * 否则 undefined（fail-closed 拒绝组合）。
   */
  bind(a: CapabilityCharge, b: CapabilityCharge): BoundCapability | undefined;
  /** 单态校验：裸能力(非全 0)→ false（结构性拒绝暴露）。 */
  isSinglet(c: CapabilityCharge): boolean;
  /** 暴露裁决：仅单态能力可暴露；裸/非单态 → confined。 */
  expose(c: CapabilityCharge): ConfinementVerdict;
}
