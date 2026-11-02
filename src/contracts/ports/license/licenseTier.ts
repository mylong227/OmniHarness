/**
 * 授权档位（**类型下沉到端口**：权益端口要引用档位，而 ports 不得依赖实现）。
 *
 * 档位高低序属**实现口径**（`LicenseEngine.TIER_RANK`），不放这里——端口只声明"有哪些档"。
 * `LicenseEngine` 反向 re-export 本类型，既有引用不受影响。
 */
export type LicenseTier = 'core' | 'pro' | 'team' | 'enterprise';
