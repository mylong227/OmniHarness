/**
 * `license` 子命令（商业化路线图 **F1**）：查看本机授权档位。
 *
 * ## 为什么需要它（而不是"有引擎就够了"）
 *
 * F1 的引擎是**纯函数**（`LicenseEngine.verify`），但"这台机器现在是什么档、为什么是这个档"
 * 必须有**用户可达的出口**：没有它，用户遇到"治理台打不开"只能去读代码。
 * 这也是 F1 的**接线证据**——引擎被真实路径消费（否则又是一条"声明未接线"）。
 *
 * ## 三条纪律
 *
 * 1. **不猜**：公钥与 license 都由调用方给出（`--license` / `--license-public-key`），
 *    命令**绝不**内置任何公钥——内置公钥等于把"谁能授权"写死在开源代码里；
 * 2. **降级不是错误**：过期/无 license ⇒ 退出码 **1** 并**明确打印"核心功能照常可用"**
 *    （沿 F1 判据②：过期是降级而非停摆）；
 * 3. **如实申报**：`ok:false` 时原样透出引擎给出的可读原因，不打"授权失败"这种无信息量的话。
 *
 * @maturity L1 — 三类退出码（有效/降级/用法）+ 原因透出 + 不内置公钥 判据钉死
 * @maturityEvidence tests/unit/licenseCommand.test.ts
 */
import { readFileSync } from 'node:fs';
import { LicenseEngine } from '../license/licenseEngine.js';
import { CliArgReader } from './cliArgReader.js';

/** 用法提示。 */
const USAGE =
  '用法: omniharness license status --license <file> --license-public-key <ssh-ed25519 …>\n' +
  '说明: 校验本机 license 并打印生效档位；无 license / 已过期 ⇒ 退出码 1（核心功能照常可用，请续期）。\n';

/** license 子命令。 */
export class LicenseCommand {
  /**
   * 执行 license 子命令。
   * @param args 子命令参数（首元素为子动作）
   * @returns 退出码（0 有效 / 1 核心档（无/过期/无效）/ 2 用法错误）
   */
  public async run(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub !== 'status') {
      process.stdout.write(USAGE);
      return 2;
    }
    const reader = new CliArgReader(args);
    const licensePath = reader.value('--license');
    const publicKey = reader.value('--license-public-key');
    if (licensePath === undefined || publicKey === undefined) {
      process.stdout.write(USAGE);
      return 2;
    }
    let text: string;
    try {
      text = readFileSync(licensePath, 'utf8');
    } catch (err) {
      // 读不到文件 ≠ 授权失败：如实说清是路径问题，并说明当前退到核心档。
      process.stderr.write(`无法读取 license 文件 ${licensePath}：${String(err)}\n`);
      process.stderr.write(LicenseCommand.coreNotice());
      return 1;
    }
    const verdict = LicenseEngine.verify({ text, publicKeySsh: publicKey });
    if (verdict.ok) {
      process.stdout.write(
        `档位 ${verdict.tier} ｜ ${verdict.reason}\n` + LicenseCommand.featureSummary(verdict.tier),
      );
      return 0;
    }
    process.stderr.write(`未采信 license：${verdict.reason}\n`);
    process.stderr.write(LicenseCommand.coreNotice());
    if (verdict.expired) {
      process.stderr.write('提示：这是**降级**不是停摆——续期后即可恢复原档位。\n');
    }
    return 1;
  }

  /**
   * 核心档降级提示（把"照常可用"写清楚，避免用户以为工具坏了）。
   * @returns 提示文本
   */
  private static coreNotice(): string {
    return `当前档位：core ｜ 核心功能照常可用（harness / 本地进化）；Pro 及以上功能未启用。\n`;
  }

  /**
   * 按档位列可用功能（只列本档**新增**的能力，供用户判断是否该升级）。
   * @param tier 当前档位
   * @returns 单行摘要
   */
  private static featureSummary(tier: string): string {
    const available = Object.entries(LicenseEngine.FEATURE_TIERS)
      .filter(([feature]) => LicenseEngine.featureAllowed(tier as 'core', feature))
      .map(([feature]) => feature);
    return `已启用功能：${available.join(', ')}\n`;
  }
}
