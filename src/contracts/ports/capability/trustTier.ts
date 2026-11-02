/**
 * 资产信任档（ADR-0009 · EVOLVIX_SPEC §6 信任-隔离矩阵的纵轴）。
 *
 * 四档从「出厂内置」到「外部进程」，**只能收紧不能放宽**（`CapabilityRegistryPort.setGovernance`
 * 的补丁只允许朝更严方向；放宽必须换显式配置路径）。
 *
 * 为什么是这四个名字：它们对应**谁签的字**，而不是「有多安全」——
 * - `core`：随包出厂、人工审过；
 * - `signed`：签名资产包验签通过（Ed25519，Wave D）；
 * - `evolved`：进化产物，只有过了晋升门禁 + 台账在案才拿到此档；
 * - `external`：MCP/A2A 等进程外来源，走既有审批与网络门禁。
 */
export type TrustTier = 'core' | 'signed' | 'evolved' | 'external';

/**
 * 信任档全序（下标越大越「不可信」= 越需要隔离）。
 *
 * 存在的理由：档位变更的「只收紧」判据需要一把**可比较的尺**；把顺序放在端口层（而不是各实现里
 * 各写一份），是为了让门禁与注册表用同一把尺（口径单点）。比较本身是一行 `indexOf`，故不另立函数。
 */
export const TRUST_TIER_ORDER: readonly TrustTier[] = ['core', 'signed', 'evolved', 'external'];
