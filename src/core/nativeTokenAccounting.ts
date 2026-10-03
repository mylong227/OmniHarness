/**
 * **token 记账路径**的选择器（G8，2026-10-03）。
 *
 * ## 存在的理由
 *
 * 本仓原先的判据是"原生内核可用就下沉 Rust"。实测（报告 §3.8 发现 1）这条路在本场景是**净亏**：
 * 同语料 1,108 条 / 775,600 字符，TS 纯计数 **6.12 ms**，走 native `context.estimate`
 * **27.8–40.7 ms（慢 4.5–6.7×）**——封送成本占主导（`JSON.stringify` 单项 12.08 ms / 925 KB，
 * 占 native 全往返 29.7%），且 Rust 侧**无缓存**而 TS 侧已有 LRU + 零分配。
 *
 * 于是默认值必须翻回 TS，而"什么时候还值得走原生"这件事需要一个**显式**开关：
 *  - 配置 `nativeTokenAccounting: true`（本仓配置链已透传，含 `audit:config-wiring` 覆盖）；
 *  - 或环境变量 `OMNI_NATIVE_TOKEN_ACCOUNTING=1`（逃生口 / 单次实验用，不必改配置）。
 *
 * ## 为什么翻转默认是安全的
 *
 * 两条路径**逐位相同**（既有断言：native 估算与 JS 结果一致）⇒ 翻转只去掉额外延迟，
 * **不改变任何记账结果**。这也是本类只需做"选路"而不必做"校对"的原因。
 */
export class NativeTokenAccounting {
  /** 环境变量名（显式开启原生记账的逃生口）。 */
  public static readonly ENV_FLAG = 'OMNI_NATIVE_TOKEN_ACCOUNTING';

  /**
   * 是否启用原生 token 记账（配置优先，其次环境变量；两者皆无 ⇒ false ＝ 走 TS）。
   * @param configured 配置里的取值（`true`/`false`/未设置）。
   * @param env 环境变量读取器（便于单测注入；缺省读 `process.env`）。
   * @returns 启用为 true。
   */
  public static enabled(
    configured: boolean | undefined,
    env: (name: string) => string | undefined = (name) => process.env[name],
  ): boolean {
    if (configured !== undefined) {
      return configured;
    }
    const raw = env(NativeTokenAccounting.ENV_FLAG)?.trim().toLowerCase();
    return raw === '1' || raw === 'true';
  }
}
