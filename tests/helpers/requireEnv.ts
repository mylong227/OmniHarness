/**
 * 「跳过即假绿」的**强制开关**助手（2026-10-11）。
 *
 * ## 为什么需要它
 *
 * 本仓的门禁哲学是 fail-closed，但有一类判据**缺环境就静默不跑**：原生内核未构建、wasm 产物缺失、
 * `sharp` 没装、`dsh` 不在 PATH、Laya 权重没放……在本地"缺了就 skip"是友好的，在 CI 上却是
 * **看着绿、其实一行没跑**。浏览器一族早已有 `OMNI_REQUIRE_BROWSER=1` 把 skip 升级为失败，
 * 其余能力**没有开关**（2026-10-11 审计实测：14 个文件里有 10 个属"无开关的静默跳过"）。
 *
 * 本模块把这件事收成一处：每个能力一个 `OMNI_REQUIRE_*` 开关，判据统一走
 * {@link RequireEnv.skipUnless} / {@link RequireEnv.guardUnless} 两种形态。
 * 开关**不在 CI 里全开**——只在"该 runner 确实能满足该能力"的作业里开（见 `.github/workflows/ci.yml`
 * 的注释）：开不了的（如 CI 不构建原生 `.node`）保持关闭，但**能力与开关都显式登记在本表里**，不再无声。
 *
 * ## 用法
 *
 * ```ts
 * // 形态 A：skip 选项（在 test() 的第二参里）
 * test('…', { ...RequireEnv.skipUnless('OMNI_REQUIRE_NATIVE', available, '内核未构建') }, async () => {…});
 *
 * // 形态 B：测试体开头（t 是 TestContext）
 * test('…', async (t) => {
 *   if (!RequireEnv.guardUnless(t, 'OMNI_REQUIRE_WASM', available, '缺 omni_wasm.wasm')) return;
 *   …
 * });
 * ```
 */
import assert from 'node:assert/strict';

/** 已知的强制开关表：环境变量名 → 它保证的能力（新增能力请在此登记，`skipSwitches` 判据会核对）。 */
export const REQUIRE_SWITCHES = {
  OMNI_REQUIRE_BROWSER: '真机浏览器（结构基线 / 真机 UI 回路面）',
  OMNI_REQUIRE_NATIVE: '原生内核 native/omni_napi.node（原生族判据）',
  OMNI_REQUIRE_WASM: 'wasm 产物 target/wasm32-unknown-unknown/release/omni_wasm.wasm（wasm 单测）',
  OMNI_REQUIRE_DSH: 'dsh CLI 在 PATH（dshWorker 契约）',
  OMNI_REQUIRE_LAYAPY: 'Laya 解释器 + 权重（真 torch 前向）',
  OMNI_REQUIRE_SHARP: 'sharp（图片缩放的**真实实现**路径）',
  OMNI_REQUIRE_LICENSE: '许可签发链（entitlements 的真实校验路径）',
} as const;

/** 开关名（取值即 {@link REQUIRE_SWITCHES} 的键）。 */
export type RequireSwitch = keyof typeof REQUIRE_SWITCHES;

/** 显式**豁免**：这些跳过与"能力缺失"无关（平台语义 / 分支两侧都有用例），故不需要开关。 */
export const PLATFORM_SKIP_EXEMPT_FILES = [
  'tests/unit/worktree.test.ts',
  'tests/unit/doctor.test.ts',
  'tests/unit/macosSeatbeltSandbox.test.ts',
] as const;

/**
 * 「跳过即假绿」的开关工具（纯静态，无状态）。
 *
 * 见模块头：把 N 处各自的 skip 判定收成一处，语义只有三条（可用⇒照跑 / 不可用且开关关⇒跳过 /
 * 不可用且开关开⇒**失败**），并由 `tests/unit/requireSwitches.test.ts` 逐条自证。
 */
export class RequireEnv {
  /** 开关是否打开（严格 `'1'`；其它值一律视为关闭，避免 `OMNI_REQUIRE_X=0` 被当成开启）。
   * @param name 开关名。
   * @returns 打开为 true。
   */
  public static isOn(name: RequireSwitch): boolean {
    return process.env[name] === '1';
  }

  /**
   * 形态 A：算出 `test()` 的 **skip 值**（与 node:test 的 `{ skip }` 字段同形，调用点写作
   * `{ skip: RequireEnv.skipUnless(...) }`；**不要**写成 `{ skip: { skip: … } }`——类型系统会当场拦住）。
   *
   * 语义：能力可用 ⇒ `false`（照跑）；不可用且开关打开 ⇒ **注册期直接失败**（文件级红，
   * 消息含能力与原因）；不可用且开关关闭 ⇒ 返回跳过原因（node:test 如实统计为 skipped）。
   * @param name 开关名。
   * @param available 能力是否可用。
   * @param reason 不可用的原因（会出现在 skip 文案里）。
   * @returns `false`（照跑）或跳过原因字符串。
   */
  public static skipUnless(
    name: RequireSwitch,
    available: boolean,
    reason: string,
  ): string | false {
    if (available) return false;
    if (RequireEnv.isOn(name)) {
      assert.fail(`${name}=1 要求「${REQUIRE_SWITCHES[name]}」，但当前不可用：${reason}`);
    }
    return reason;
  }

  /**
   * 形态 B：测试体开头的守卫（需要 `t.skip` 的场合）。
   * @param t 测试上下文（只需 `skip`）。
   * @param name 开关名。
   * @param available 能力是否可用。
   * @param reason 不可用的原因。
   * @returns 可以继续执行返回 true；已跳过返回 false（调用方应立刻 `return`）。
   */
  public static guardUnless(
    t: { skip: (reason: string) => void },
    name: RequireSwitch,
    available: boolean,
    reason: string,
  ): boolean {
    if (available) return true;
    if (RequireEnv.isOn(name)) {
      assert.fail(`${name}=1 要求「${REQUIRE_SWITCHES[name]}」，但当前不可用：${reason}`);
    }
    t.skip(reason);
    return false;
  }
}
