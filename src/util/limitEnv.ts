import { log } from './logger.js';

/**
 * 环境变量整数限制读取器（fail-safe）。
 *
 * 把「并发上限 / 体积上限 / 超时」这类运维可调的安全闸从硬编码常量改为环境变量可配，
 * 同时保证「未配置或非法值」安全回退到出厂默认——绝不因一个坏环境变量让服务以危险口径运行。
 *
 * 约定：读取发生在模块加载期（进程启动即定型），与仓库其它运维限制（如 `OMNI_EVAL_TEST_TIMEOUT_MS`）
 * 的惯例一致；单测直接覆盖本类的校验分支。
 */
export class LimitEnv {
  /**
   * 读取整数型限制。
   *
   * @param name 环境变量名。
   * @param fallback 回退值（环境未配置、为空、非整数、或小于 `min` 时采用）。
   * @param min 允许的最小值（含）；低于此值视为非法并回退。默认 1。
   * @returns 生效的整数限制（永远 `>= min` 或 `fallback`）。
   */
  public static int(name: string, fallback: number, min = 1): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
      log.warn('limitEnv.invalid', { name, raw, fallback });
      return fallback;
    }
    return parsed;
  }
}
