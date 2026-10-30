/**
 * `limits` 配置段严格校验（fail-closed）。
 *
 * ## 为什么单独成类
 *
 * `configError.ts` 是「一文件一类」形态（`ConfigError`），再塞一个校验类会越红线；
 * 新增顶层 `function` 又违反 D9。故与 `mediaConfigValidator` / `ssrfPolicyValidator` 同形：
 * 独立类 + 一条注册项接入 `FIELD_VALIDATORS`。
 *
 * ## 为什么校验逻辑本体在 `util/runtimeLimits.ts`
 *
 * 「哪些键、什么区间」必须与运行时解析器**同源**——否则配置校验放过一个解析器不认的键，
 * 用户会看到「配置写了却没生效」。故本类只做接线，规则表与解析都在 `RuntimeLimits`。
 *
 * ## 为什么参数用**结构类型**而不是 import `FileConfig`
 *
 * `configError → configFile → profileLoader → …` 本来就是一个依赖环；再让本类 import
 * `FileConfig` 会把这个环**扩到 8 个成员**，架构门禁判为「新增环」而红。本类只读 `limits`
 * 一个字段，按结构取参数即可切断这条边（类型上 FileConfig 仍可传入）。
 *
 * 返回值约定与同层校验器一致：返回**错误消息字符串**（合法则 `undefined`），
 * 本模块因此无需 import `configError.ts` 的值，从根上避免循环依赖。
 */

import { RuntimeLimits, type RuntimeLimitsConfig } from '../util/runtimeLimits.ts';

/** `limits` 段校验器（无状态，可并发复用）。 */
export class LimitsConfigValidator {
  /**
   * 校验配置里的 `limits` 段：段名 / 键名 / 整数 / 区间。
   * @param cfg 已归一化的分层配置（只读 `limits` 字段）。
   * @returns 首个错误消息；合法（或未配置）时返回 `undefined`。
   */
  public validate(cfg: { readonly limits?: RuntimeLimitsConfig }): string | undefined {
    return RuntimeLimits.validateConfig(cfg.limits);
  }
}

/** 默认无状态实例（调用点以 `limitsConfigValidator.validate` 零构造复用）。 */
export const limitsConfigValidator = new LimitsConfigValidator();
