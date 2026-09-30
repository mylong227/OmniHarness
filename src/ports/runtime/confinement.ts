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
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./confinement/`，调用点零改动。
 */

export type { Charge } from './confinement/charge.js';
export type { CapabilityCharge } from './confinement/capabilityCharge.js';
export type { BoundCapability } from './confinement/boundCapability.js';
export type { ConfinementVerdict } from './confinement/confinementVerdict.js';
export type { ConfinementPort } from './confinement/confinementPort.js';
