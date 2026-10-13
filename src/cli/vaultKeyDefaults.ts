/**
 * 凭据保险库的**主密钥来源**默认值（2026-10-11）。
 *
 * ## 解决什么（实测 footgun）
 *
 * `CryptoVault` 的主密钥来源有三档：环境变量 → 密钥文件 → **内存随机**。而第三档在
 * `keyFile` 未配置时**不落盘**：同一个进程内能读写，进程一退，密钥就没了 ⇒ 它写下的密文
 * **永久读不回**（`vault set` 当次看着成功）。这正是 serve 侧第 7 轮拒绝注入保险库的原因
 * （注入了只会显示"能用但永远读空"），也是启动横幅常驻
 * `ℹ️ 凭据保险库未接线（设 OMNIHARNESS_VAULT_KEY 或 --vault-key-file …）` 的由来。
 *
 * ## 现在的口径
 *
 * 没有任何显式来源时，用**用户级默认密钥文件** `~/.omniharness/vault.key`（首次使用时生成，
 * 权限 0600，与 `--vault-key-file` 同规格）。优先级保持：
 * **`OMNIHARNESS_VAULT_KEY` > 显式 `--vault-key-file` > 默认密钥文件（自动生成）**。
 * 想彻底关掉保险库（不建任何密钥文件、Web 端如实显示未接线）：`OMNIHARNESS_VAULT=0`。
 *
 * ## 迁移注意（诚实登记）
 *
 * 以前用"内存随机密钥"写下的密文**本来就不可恢复**（密钥从未落盘）。换到默认密钥文件后，
 * 读那些条目会**明确报错**（GCM 认证失败/fail-closed），而不会返回错误明文——这是刻意的：
 * 宁可报错，也不让调用方拿到错误的凭据。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认主密钥文件（用户级）。 */
export const DEFAULT_VAULT_KEY_FILE: string = join(homedir(), '.omniharness', 'vault.key');

/** 关闭保险库的环境变量（置 `0`/`off`/`false` 生效）。 */
const VAULT_ENABLED_ENV = 'OMNIHARNESS_VAULT';

/** 主密钥来源解析。 */
export class VaultKeyDefaults {
  /**
   * 解析主密钥文件路径：显式值优先，否则用用户级默认。
   * @param explicit 显式 `--vault-key-file` 取值（可缺省）。
   * @returns 主密钥文件路径。
   */
  public static resolveKeyFile(explicit?: string | undefined): string {
    const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
    return trimmed === '' ? DEFAULT_VAULT_KEY_FILE : trimmed;
  }

  /**
   * 是否被环境变量显式关闭（`OMNIHARNESS_VAULT=0|off|false`）。
   * @param env 环境（缺省 `process.env`，供判据注入）。
   * @returns 关闭为 true。
   */
  public static disabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env[VAULT_ENABLED_ENV] ?? '').trim().toLowerCase();
    return raw === '0' || raw === 'off' || raw === 'false';
  }

  /**
   * 人可读的主密钥来源描述（供启动横幅与判据断言；**不含密钥内容**）。
   * @param explicit 显式 `--vault-key-file` 取值（可缺省）。
   * @param env 环境（缺省 `process.env`）。
   * @returns 来源描述。
   */
  public static describeSource(
    explicit?: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    const fromEnv = (env.OMNIHARNESS_VAULT_KEY ?? '').trim();
    if (fromEnv !== '') {
      return '环境变量 OMNIHARNESS_VAULT_KEY';
    }
    const file = VaultKeyDefaults.resolveKeyFile(explicit);
    return `密钥文件 ${file}${explicit === undefined || explicit.trim() === '' ? '（用户级默认，首次使用时生成）' : ''}`;
  }
}
