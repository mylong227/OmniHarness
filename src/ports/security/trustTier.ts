/**
 * @beta
 * 工具输出来源**信任级**（越不可信越敏感）。
 *
 * 2026-10-11 从 `src/security/toolOutputTrust.ts` 外迁至端口层：`ports/config/omniHarnessConfig.ts`
 * 需要这个类型来表达"外部内容信任档"的配置面，而原先它从**实现文件**导入 ⇒ 触发
 * `architectureGate` 的 `ports→实现层` 禁边。类型本身不含任何实现，属端口层该有的东西；
 * 原位置改为再导出，调用点零改动。
 */
export type TrustTier = 'external' | 'file' | 'local' | 'memory' | 'unknown';
