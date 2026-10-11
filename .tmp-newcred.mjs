// 一次性改造（不入库）：新建凭据构造层，并把 CliBuildConfig 改为继承它。
import { readFileSync, writeFileSync } from 'node:fs';

/** 去 BOM 写回。 */
function write(file, text) {
  writeFileSync(file, text.replace(/^\uFEFF/u, ''), 'utf8');
}

const moved = readFileSync('.tmp-moved-cred.txt', 'utf8');

const header = `/**
 * CLI 的**凭据构造层**：保险库（VaultPort）的装配与凭据水合（2026-10-11 从 cliBuildConfig.ts 外移）。
 *
 * ## 为什么单独成层
 *
 * 加上 Web 交付的 \`buildServeVault\` 后，\`CliBuildConfig\` 越过编码标准的**上帝类**阈值
 * （702 行 / 26 方法）。处置是**按职责外移**（本层职责：把凭据来源装配成端口、并在需要时水合进环境），
 * 而不是放宽阈值——本仓的惯例一贯如此（\`cliFlagTable\` / \`cliValueFlags\` 也是这么分出去的）。
 *
 * 继承链：\`CliBuildConfig extends CliCredentialBuild\`；调用点零改动。
 */
import { CryptoVault } from '../adapters/vault/cryptoVault.js';
import { CredentialResolver } from '../security/credentialResolver.js';
import { KvStoreFactory } from './kvStoreFactory.js';
import type { VaultPort } from '../ports/memory/vault.js';
import type { FileConfig } from '../config/configFile.js';
import type { ResolvedConfig } from '../ports/config/resolvedConfig.js';

/** 凭据水合所需的最小参数集（原属 cliBuildConfig，随方法一并外移）。 */
export interface CredentialHydrationArgs {
  readonly vaultHydrate?: boolean | undefined;
  readonly vaultHydrateNames?: readonly string[] | undefined;
  readonly vaultKeyFile?: string | undefined;
  readonly kvAdapter?: 'memory' | 'json-file' | 'sqlite' | undefined;
  readonly kvFile?: string | undefined;
}

/** 凭据构造层（作为 CliBuildConfig 的基类）。 */
export class CliCredentialBuild {
  /**
   * 供子类使用的配置构建钩子（本层不实现，仅声明以保持分层自洽）。
   * @param args 已解析参数
   * @returns 解析后的配置
   */
  protected async buildConfig(args: CredentialHydrationArgs): Promise<ResolvedConfig> {
    void args;
    throw new Error('CliCredentialBuild.buildConfig 必须由子类实现');
  }

  /**
   * 供子类使用的配置文件读取钩子（本层不实现）。
   * @param args 已解析参数
   * @returns 文件级配置
   */
  protected loadFileConfig(args: CredentialHydrationArgs): FileConfig {
    void args;
    throw new Error('CliCredentialBuild.loadFileConfig 必须由子类实现');
  }
}
`;

write('src/cli/cliCredentialBuild.ts', `${header}\n${moved}`);
console.log('已新建 cliCredentialBuild.ts');

// 把 moved 里的方法改成"层内方法"（它们本就是 protected 实例方法，无需改名）
const src = 'src/cli/cliBuildConfig.ts';
let text = readFileSync(src, 'utf8');
text = text.replace(
  'export class CliBuildConfig extends CliServerCmds {',
  'export class CliBuildConfig extends CliCredentialBuild {',
);
if (!text.includes('extends CliCredentialBuild')) {
  // 真实的继承形态可能不同，报出来让人工确认
  const m = /export class CliBuildConfig[^{]*\{/.exec(text);
  throw new Error(`CliBuildConfig 继承形态未命中：${m === null ? '未找到类声明' : m[0]}`);
}
write(src, text);
console.log('已改为继承 CliCredentialBuild');
