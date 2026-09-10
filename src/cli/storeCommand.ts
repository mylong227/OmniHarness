/**
 * kv / vault 子命令（StoreCommand）——本地键值存储与凭据保险库。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价。两个子命令共享 KV 后端工厂（KvStoreFactory）：
 * vault 的 crypto 后端即「KV 后端 + 主密钥文件」的组合，故二者聚合为一个内聚的「存储」命令域。
 *
 * 用法：
 *   kv get|set|del|list    [--key K] [--value V] [--prefix P] [--kv-file PATH] [--kv-adapter ...]
 *   vault get|set|del|list [--name N] [--value V] [--vault-backend crypto|env] [--kv-* ...] [--vault-key-file PATH]
 */

import { CryptoVault } from '../adapters/vault/cryptoVault.js';
import { EnvVault } from '../adapters/vault/envVault.js';
import type { VaultPort } from '../ports/vault.js';
import { messageOf } from './args.js';
import { CliArgReader } from './cliArgReader.js';
import { KvStoreFactory, type KvHandle } from './kvStoreFactory.js';

/** kv 用法提示。 */
const KV_USAGE =
  '用法: omniharness kv get|set|del|list [--key K] [--value V] [--prefix P] [--kv-file PATH]\n';
/** vault 用法提示。 */
const VAULT_USAGE =
  '用法: omniharness vault get|set|del|list [--name N] [--value V] [--vault-backend crypto|env] [--kv-adapter memory|json-file|sqlite] [--kv-file PATH] [--vault-key-file PATH]\n';

export class StoreCommand {
  /** KV 后端工厂（kv 与 vault 共用）。 */
  private readonly kvFactory = new KvStoreFactory();

  /**
   * 执行 kv 子命令（get / set / del / list）。
   * @param args 子命令参数（已去掉 `kv`，首元素为 get/set/del/list）。
   * @returns 进程退出码（0 成功 / 1 未找到或出错 / 2 用法错误）。
   */
  public async runKv(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const reader = new CliArgReader(args);
    try {
      const kv = await this.kvFactory.create(args);
      try {
        if (sub === 'get') {
          return await this.kvGet(kv, reader);
        }
        if (sub === 'set') {
          return await this.kvSet(kv, reader);
        }
        if (sub === 'del') {
          return await this.kvDel(kv, reader);
        }
        if (sub === 'list') {
          return await this.kvList(kv, reader);
        }
      } finally {
        await kv.close();
      }
    } catch (error) {
      console.error(`KV 操作失败: ${messageOf(error)}`);
      return 1;
    }
    process.stdout.write(KV_USAGE);
    return 2;
  }

  /**
   * 执行 vault 子命令（get / set / del / list）。
   * @param args 子命令参数（已去掉 `vault`，首元素为 get/set/del/list）。
   * @returns 进程退出码（0 成功 / 1 未找到或出错 / 2 用法错误）。
   */
  public async runVault(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const reader = new CliArgReader(args);
    try {
      const vault = await this.buildVault(args);
      try {
        if (sub === 'get') {
          return await this.vaultGet(vault, reader);
        }
        if (sub === 'set') {
          return await this.vaultSet(vault, reader);
        }
        if (sub === 'del') {
          return await this.vaultDel(vault, reader);
        }
        if (sub === 'list') {
          return await this.vaultList(vault);
        }
      } finally {
        await vault.close();
      }
    } catch (error) {
      console.error(`凭据操作失败: ${messageOf(error)}`);
      return 1;
    }
    process.stdout.write(VAULT_USAGE);
    return 2;
  }

  /**
   * 构造凭据保险库：--vault-backend env 走环境变量回退；否则 crypto 后端（KV 后端 + 主密钥文件）。
   * @param args 子命令参数。
   * @returns 凭据端口（调用方负责 close）。
   */
  private async buildVault(args: readonly string[]): Promise<VaultPort> {
    const reader = new CliArgReader(args);
    if ((reader.value('--vault-backend') ?? 'crypto') === 'env') {
      return new EnvVault();
    }
    const keyFile = reader.value('--vault-key-file');
    const kv = await this.kvFactory.create(args);
    return new CryptoVault({ kv, keyFile });
  }

  /**
   * kv get。
   * @param kv KV 端口。
   * @param reader 参数读取器。
   * @returns 退出码（0 命中 / 1 未找到）。
   */
  private async kvGet(kv: KvHandle, reader: CliArgReader): Promise<number> {
    const key = reader.value('--key') ?? reader.at(1);
    if (key === undefined) {
      throw new Error('kv get 需要 --key KEY');
    }
    const value = await kv.get(key);
    if (value === undefined) {
      process.stdout.write(`(未找到: ${key})\n`);
      return 1;
    }
    process.stdout.write(`${value}\n`);
    return 0;
  }

  /**
   * kv set。
   * @param kv KV 端口。
   * @param reader 参数读取器。
   * @returns 退出码（恒 0）。
   */
  private async kvSet(kv: KvHandle, reader: CliArgReader): Promise<number> {
    const key = reader.value('--key') ?? reader.at(1);
    const value = reader.value('--value') ?? reader.at(2);
    if (key === undefined || value === undefined) {
      throw new Error('kv set 需要 --key KEY --value VALUE');
    }
    await kv.set(key, value);
    process.stdout.write(`已写入 ${key}\n`);
    return 0;
  }

  /**
   * kv del。
   * @param kv KV 端口。
   * @param reader 参数读取器。
   * @returns 退出码（0 已删除 / 1 不存在）。
   */
  private async kvDel(kv: KvHandle, reader: CliArgReader): Promise<number> {
    const key = reader.value('--key') ?? reader.at(1);
    if (key === undefined) {
      throw new Error('kv del 需要 --key KEY');
    }
    const removed = await kv.delete(key);
    process.stdout.write(removed ? `已删除 ${key}\n` : `(不存在: ${key})\n`);
    return removed ? 0 : 1;
  }

  /**
   * kv list（按前缀前缀过滤）。
   * @param kv KV 端口。
   * @param reader 参数读取器。
   * @returns 退出码（恒 0）。
   */
  private async kvList(kv: KvHandle, reader: CliArgReader): Promise<number> {
    const prefix = reader.value('--prefix') ?? '';
    const entries = await kv.list(prefix);
    if (entries.length === 0) {
      process.stdout.write('(空)\n');
      return 0;
    }
    for (const entry of entries) {
      process.stdout.write(`${entry.key}\t${entry.value}\n`);
    }
    return 0;
  }

  /**
   * vault get。
   * @param vault 凭据端口。
   * @param reader 参数读取器。
   * @returns 退出码（0 命中 / 1 未找到）。
   */
  private async vaultGet(vault: VaultPort, reader: CliArgReader): Promise<number> {
    const name = reader.value('--name') ?? reader.at(1);
    if (name === undefined) {
      throw new Error('vault get 需要 --name NAME');
    }
    const value = await vault.getSecret(name);
    if (value === undefined) {
      process.stdout.write(`(未找到: ${name})\n`);
      return 1;
    }
    process.stdout.write(`${value}\n`);
    return 0;
  }

  /**
   * vault set。
   * @param vault 凭据端口。
   * @param reader 参数读取器。
   * @returns 退出码（恒 0）。
   */
  private async vaultSet(vault: VaultPort, reader: CliArgReader): Promise<number> {
    const name = reader.value('--name') ?? reader.at(1);
    const value = reader.value('--value') ?? reader.at(2);
    if (name === undefined || value === undefined) {
      throw new Error('vault set 需要 --name NAME --value VALUE');
    }
    await vault.setSecret(name, value);
    process.stdout.write(`已写入凭据 ${name}\n`);
    return 0;
  }

  /**
   * vault del。
   * @param vault 凭据端口。
   * @param reader 参数读取器。
   * @returns 退出码（0 已删除 / 1 不存在）。
   */
  private async vaultDel(vault: VaultPort, reader: CliArgReader): Promise<number> {
    const name = reader.value('--name') ?? reader.at(1);
    if (name === undefined) {
      throw new Error('vault del 需要 --name NAME');
    }
    const removed = await vault.deleteSecret(name);
    process.stdout.write(removed ? `已删除凭据 ${name}\n` : `(不存在: ${name})\n`);
    return removed ? 0 : 1;
  }

  /**
   * vault list。
   * @param vault 凭据端口。
   * @returns 退出码（恒 0）。
   */
  private async vaultList(vault: VaultPort): Promise<number> {
    const names = await vault.listSecrets();
    if (names.length === 0) {
      process.stdout.write('(空)\n');
      return 0;
    }
    for (const name of names) {
      process.stdout.write(`${name}\n`);
    }
    return 0;
  }
}
