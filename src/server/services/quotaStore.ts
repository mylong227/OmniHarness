import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 配额设置（落盘字段，全部可选——缺失即用缺省值）。
 *
 * ⚠️ **`plan` 已不在其中**（2026-10-17）：档位改为按当前模型自动识别
 * （见 `quotaPlans.ts` 的 `QuotaPlans.forModel`），不再落盘、不再可写。
 * 旧版本的 `quota.json` 里可能仍有 `"plan"` 字段——`read()` 会忽略它，
 * 下一次 `write()` 落盘时该字段自然消失（不做迁移脚本：它是死数据，留着无害）。
 */
export interface QuotaSettings {
  /** 基础日 token 预算（倍率乘算前的基数）。 */
  readonly dailyTokens: number;
}

/** 目录名（相对工作区）：与 `.omniharness/sessions`、`.omniharness/longterm` 同级同约定。 */
const QUOTA_DIR = '.omniharness';

/** 文件名。 */
const QUOTA_FILE = 'quota.json';

/** 缺省基础日预算（100 万 token）：足够一次长会话，又不至于让人察觉不到配额存在。 */
const DEFAULT_DAILY_TOKENS = 1_000_000;

/**
 * 配额设置存储：读写工作区内的 `.omniharness/quota.json`。
 *
 * 与 `ServerConfigStore`（配置）分离的理由：配额是**用量策略**不是运行时配置，
 * 混进 omniharness.json 会让「重置用量 / 调预算」顺带重写模型与凭据字段，风险不对等。
 *
 * 容错策略（刻意宽松）：
 *  - 文件缺失 → 缺省值（首次启动零配置可用）；
 *  - 文件损坏 / 字段非法 → 该字段回退缺省值并**不抛错**（配额面板拒绝加载比显示默认值更糟）；
 *  - 写入失败 → 抛错上抛（用户明确改了设置却没落盘必须可见，不能静默丢）。
 */
export class QuotaStore {
  /**
   * @param workspaceRoot 当前生效工作区根（getter 注入，支持运行时切换项目）
   */
  public constructor(private readonly workspaceRoot: () => string) {}

  /**
   * 读取设置（缺省值兜底）。
   * @returns 完整的配额设置（字段必定有值）
   */
  public read(): QuotaSettings {
    const raw = this.readRaw();
    const daily = raw['dailyTokens'];
    const dailyTokens =
      typeof daily === 'number' && Number.isFinite(daily) && daily > 0
        ? Math.floor(daily)
        : DEFAULT_DAILY_TOKENS;
    return { dailyTokens };
  }

  /**
   * 局部更新设置并落盘。
   *
   * @param patch 待更新字段（未提供的字段保持原值）
   * @returns 落盘后的完整设置
   * @throws 日预算非正数时抛错（fail-closed：不把非法值写进磁盘）
   */
  public write(patch: Partial<QuotaSettings>): QuotaSettings {
    const current = this.read();
    let dailyTokens = current.dailyTokens;
    if (patch.dailyTokens !== undefined) {
      if (!Number.isFinite(patch.dailyTokens) || patch.dailyTokens <= 0) {
        throw new Error('日预算必需为正数');
      }
      dailyTokens = Math.floor(patch.dailyTokens);
    }
    const next: QuotaSettings = { dailyTokens };
    const file = this.filePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  /**
   * 设置文件的绝对路径（工作区根 × `.omniharness/quota.json`）。
   * @returns quota.json 的绝对路径
   */
  public filePath(): string {
    return join(this.workspaceRoot(), QUOTA_DIR, QUOTA_FILE);
  }

  /**
   * 读原始 JSON 对象；文件缺失 / 解析失败 / 非对象一律返回空对象。
   * @returns 原始键值映射（字段级校验与缺省兜底在 {@link QuotaStore.read} 完成）
   */
  private readRaw(): Record<string, unknown> {
    const file = this.filePath();
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
