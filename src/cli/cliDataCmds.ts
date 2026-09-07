/**
 * cliDataCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 4/6 层）。
 *
 * 承载「数据 / 存储 / 插件」类子命令：session / plugin / audit / kv / vault。
 * （compare 对比簇已拆至 cliCompareCmds.ts。）
 * 方法体逐字节等价于原 exec.ts，`private`→`protected`。继承自 CliMcpCmds。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { Container } from '../core/container.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { manifestHasDangerous } from '../plugin/manifest.js';
import { PermissionGate, PermissionDeniedError } from '../plugin/permissionGate.js';
import { isPluginPermission } from '../plugin/permission.js';
import type { PluginPermission } from '../plugin/permission.js';
import type { Plugin } from '../plugin/plugin.js';
import { AuditSink } from '../server/audit.js';
import {
  formatAudit,
  queryAudit,
  buildComplianceReport,
  formatCompliance,
  type AuditFormat,
  type AuditQuery,
} from '../server/auditExport.js';
import { MemoryKv } from '../adapters/kv/memoryKv.js';
import { JsonFileKv } from '../adapters/kv/jsonFileKv.js';
import type { SqliteKv } from '../adapters/kv/sqliteKv.js';
import { CryptoVault } from '../adapters/vault/cryptoVault.js';
import { EnvVault } from '../adapters/vault/envVault.js';
import type { VaultPort } from '../ports/vault.js';
import { messageOf } from './args.js';
import { CliMcpCmds } from './cliMcpCmds.js';
import { ConfigFile } from '../config/configFile.js';
import { PluginProfileStore, sanitizeProfileName } from '../plugin/pluginProfile.js';
import { packBundle, unpackBundle } from '../plugin/bundle.js';

/** 数据 / 存储 / 插件类子命令。 */
export class CliDataCmds extends CliMcpCmds {
  /** 会话子命令：session list。 */
  protected async runSession(args: readonly string[]): Promise<number> {
    if (args[0] !== 'list') {
      process.stdout.write('用法: omniharness session list [--storage-dir DIR]\n');
      return 2;
    }
    const dir =
      this.flagValue(args, '--storage-dir') ?? join(homedir(), '.omniharness', 'sessions');
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    if (names.length === 0) {
      process.stdout.write('（无会话文件）\n');
      return 0;
    }
    for (const name of names) {
      const file = join(dir, name);
      const content = await readFile(file, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim() !== '');
      const first =
        lines[0] === undefined ? undefined : (JSON.parse(lines[0]) as { sessionId?: string });
      const sessionId = first?.sessionId ?? name.replace('.jsonl', '');
      const info = await stat(file);
      process.stdout.write(`${sessionId}\t${lines.length} 事件\t${info.mtime.toISOString()}\n`);
    }
    return 0;
  }

  /** 插件子命令：plugin load / list / search / install / remove。 */
  protected async runPlugin(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub === 'load') {
      const file = this.flagValue(args, '--file');
      if (file === undefined) {
        process.stdout.write(
          '用法: omniharness plugin load --file PATH [--allow PERM ...] [--allow-all]\n',
        );
        return 2;
      }
      const allowAll = args.includes('--allow-all');
      const allowed = this.collectFlags(args, '--allow');
      for (const permission of allowed) {
        if (!isPluginPermission(permission)) {
          process.stdout.write(`未知权限: ${permission}（合法项见 ALL_PERMISSIONS）\n`);
          return 2;
        }
      }
      const gate = allowAll
        ? PermissionGate.allowAll()
        : PermissionGate.fromList(allowed as PluginPermission[]);
      const module = await import(pathToFileURL(resolve(file)).href);
      const plugin = module.default as { meta?: { name?: string } };
      const manager = new PluginManager(new Container(), gate);
      try {
        await manager.register(plugin as Plugin);
      } catch (error) {
        if (error instanceof PermissionDeniedError) {
          console.error(`${error.message}`);
          return 1;
        }
        throw error;
      }
      process.stdout.write(`插件加载: ${plugin.meta?.name ?? file}\n`);
      return 0;
    }
    if (sub === 'list') {
      const installed = await this.createRegistry(args).list();
      if (installed.length === 0) {
        process.stdout.write(
          '（无已安装插件；用 plugin search 发现，plugin install <name> 安装）\n',
        );
        return 0;
      }
      for (const manifest of installed) {
        const flag = manifestHasDangerous(manifest) ? '  [危险权限]' : '';
        process.stdout.write(
          `${manifest.name}@${manifest.version}\t${manifest.description ?? ''}${flag}\n`,
        );
      }
      return 0;
    }
    if (sub === 'search') {
      const query = this.flagValue(args, '--query') ?? args[1];
      const results = await this.createRegistry(args).search(query);
      if (results.length === 0) {
        process.stdout.write('（无匹配插件）\n');
        return 0;
      }
      for (const descriptor of results) {
        const flag = manifestHasDangerous(descriptor.manifest) ? '  [危险权限]' : '';
        process.stdout.write(
          `[${descriptor.source}]\t${descriptor.manifest.name}@${descriptor.manifest.version}\t${descriptor.manifest.description ?? ''}${flag}\n`,
        );
      }
      return 0;
    }
    if (sub === 'install') {
      const name = args[1];
      if (name === undefined) {
        process.stdout.write('用法: omniharness plugin install <name> [--dir DIR]\n');
        return 2;
      }
      try {
        const manifest = await this.createRegistry(args).install(name);
        const warn = manifestHasDangerous(manifest)
          ? '\n注意: 该插件声明危险权限，加载时将被 PermissionGate 拦截，除非显式 --allow 放行。'
          : '';
        process.stdout.write(`已安装插件: ${manifest.name}@${manifest.version}${warn}\n`);
        return 0;
      } catch (error) {
        console.error(`安装失败: ${messageOf(error)}`);
        return 1;
      }
    }
    if (sub === 'remove') {
      const name = args[1];
      if (name === undefined) {
        process.stdout.write('用法: omniharness plugin remove <name> [--dir DIR]\n');
        return 2;
      }
      try {
        await this.createRegistry(args).remove(name);
        process.stdout.write(`已移除插件: ${name}\n`);
        return 0;
      } catch (error) {
        console.error(`移除失败: ${messageOf(error)}`);
        return 1;
      }
    }
    process.stdout.write(
      '用法: omniharness plugin load --file PATH [--allow PERM ...] | plugin list | plugin search [QUERY] | plugin install <name> | plugin remove <name>\n',
    );
    return 2;
  }

  /** 审计导出：audit export —— 读回落盘审计日志，按条件过滤并导出（或生成合规报告）。 */
  protected async runAudit(args: readonly string[]): Promise<number> {
    if (args[0] !== 'export') {
      process.stdout.write(
        '用法: omniharness audit export [--audit-dir DIR | --audit-file PATH] ' +
          '[--since ISO] [--until ISO] [--type T] [--session S] [--actor A] ' +
          '[--format json|table|csv] [--out FILE] [--limit N] [--compliance]\n',
      );
      return 2;
    }
    const rest = args.slice(1);
    const auditDir = this.flagValue(rest, '--audit-dir') ?? process.env['OMNI_AUDIT_DIR'];
    const auditFile = this.flagValue(rest, '--audit-file');
    const sink = new AuditSink(
      auditFile !== undefined
        ? { path: auditFile }
        : auditDir !== undefined
          ? { dir: auditDir }
          : {},
    );
    const query: AuditQuery = {
      since: this.flagValue(rest, '--since') ?? undefined,
      until: this.flagValue(rest, '--until') ?? undefined,
      type: this.flagValue(rest, '--type') ?? undefined,
      session: this.flagValue(rest, '--session') ?? undefined,
      actor: this.flagValue(rest, '--actor') ?? undefined,
      limit: (() => {
        const raw = this.flagValue(rest, '--limit');
        if (raw === undefined) return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      })(),
    };
    const events = sink.read();
    // 合规导出：生成结构化合规报告（摘要 + 完整性哈希 + **哈希链校验**），供企业审计消费。
    if (rest.includes('--compliance')) {
      const chain = sink.verify();
      const report = buildComplianceReport(events, query, { generatedBy: 'omniharness' }, chain);
      // fail-closed：链确凿断裂（ok===false）意味着日志被删改，报告不可作为审计证据，
      // 明确告警并以非零码退出；旧格式日志（ok===null，无链字段）仅不可验证、非篡改，正常出具。
      if (chain.ok === false) {
        process.stderr.write(
          `[omniharness] 审计哈希链校验失败：${chain.reason ?? '未知原因'}（断裂处 seq=${String(chain.brokenAt)}）\n` +
            `              该报告不可作为合规证据，请核查审计日志完整性。\n`,
        );
      }
      const chainLabel = chain.ok === true ? '完整' : chain.ok === false ? '断裂' : '未启用';
      const text = formatCompliance(report);
      const outFile = this.flagValue(rest, '--out');
      if (outFile !== undefined) {
        writeFileSync(outFile, text);
        process.stdout.write(
          `已导出合规报告（${report.summary.total} 条事件，完整性哈希 ${report.summary.integrityHash.slice(0, 16)}…，哈希链 ${chainLabel}）到 ${outFile}\n`,
        );
      } else {
        process.stdout.write(text + '\n');
      }
      return chain.ok === false ? 1 : 0;
    }
    const formatRaw = this.flagValue(rest, '--format');
    const format: AuditFormat = formatRaw === 'json' || formatRaw === 'csv' ? formatRaw : 'table';
    const filtered = queryAudit(events, query);
    const matched = formatAudit(filtered, format);
    const outFile = this.flagValue(rest, '--out');
    if (outFile !== undefined) {
      writeFileSync(outFile, matched);
      process.stdout.write(`已导出 ${filtered.length} 条审计事件到 ${outFile}\n`);
    } else {
      process.stdout.write(matched);
    }
    return 0;
  }

  /** kv：通用键值存储（可交互读写，默认 JSON 文件，--kv-adapter 可选）。 */
  protected async runKv(args: readonly string[]): Promise<number> {
    const sub = args[0];
    try {
      const kv = await this.buildKv(args);
      const backend = args.findIndex((a) => a === '--kv-adapter');
      const adapterName = backend >= 0 ? args[backend + 1] : 'json-file';
      try {
        if (sub === 'get') {
          const key = this.flagValue(args, '--key') ?? args[1];
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
        if (sub === 'set') {
          const key = this.flagValue(args, '--key') ?? args[1];
          const value = this.flagValue(args, '--value') ?? args[2];
          if (key === undefined || value === undefined) {
            throw new Error('kv set 需要 --key KEY --value VALUE');
          }
          await kv.set(key, value);
          process.stdout.write(`已写入 ${key}\n`);
          return 0;
        }
        if (sub === 'del') {
          const key = this.flagValue(args, '--key') ?? args[1];
          if (key === undefined) {
            throw new Error('kv del 需要 --key KEY');
          }
          const removed = await kv.delete(key);
          process.stdout.write(removed ? `已删除 ${key}\n` : `(不存在: ${key})\n`);
          return removed ? 0 : 1;
        }
        if (sub === 'list') {
          const prefix = this.flagValue(args, '--prefix') ?? '';
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
        void adapterName;
      } finally {
        await kv.close();
      }
    } catch (error) {
      console.error(`KV 操作失败: ${messageOf(error)}`);
      return 1;
    }
    process.stdout.write(
      '用法: omniharness kv get|set|del|list [--key K] [--value V] [--prefix P] [--kv-file PATH]\n',
    );
    return 2;
  }

  /** 构建 KV 端口（默认 JSON 文件，--kv-adapter memory|json-file|sqlite）。 */
  protected async buildKv(args: readonly string[]): Promise<MemoryKv | JsonFileKv | SqliteKv> {
    const backend = args.findIndex((a) => a === '--kv-adapter');
    const adapter = backend >= 0 ? args[backend + 1] : 'json-file';
    const file = this.flagValue(args, '--kv-file') ?? '.omniharness-kv.json';
    if (adapter === 'memory') {
      return new MemoryKv();
    }
    if (adapter === 'sqlite') {
      const dbFile = this.flagValue(args, '--kv-file') ?? '.omniharness-kv.db';
      // 懒加载：node:sqlite 仅 Node ≥22.5 提供，静态导入会让旧 Node 上所有命令启动即崩
      const { SqliteKv } = await import('../adapters/kv/sqliteKv.js');
      return new SqliteKv(dbFile);
    }
    return new JsonFileKv(file);
  }

  /**
   * vault：凭据保险库（AES-256-GCM 加密落盘，可复用 KV 后端；未配置密钥时回退环境变量）。
   * 用法: omniharness vault get|set|del|list [--name N] [--value V] [--vault-backend crypto|env] [--kv-adapter ...] [--kv-file PATH] [--vault-key-file PATH]
   */
  protected async runVault(args: readonly string[]): Promise<number> {
    const sub = args[0];
    try {
      const vault = await this.buildVault(args);
      const backend = args.findIndex((a) => a === '--vault-backend');
      const backendName = backend >= 0 ? args[backend + 1] : 'crypto';
      try {
        if (sub === 'get') {
          const name = this.flagValue(args, '--name') ?? args[1];
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
        if (sub === 'set') {
          const name = this.flagValue(args, '--name') ?? args[1];
          const value = this.flagValue(args, '--value') ?? args[2];
          if (name === undefined || value === undefined) {
            throw new Error('vault set 需要 --name NAME --value VALUE');
          }
          await vault.setSecret(name, value);
          process.stdout.write(`已写入凭据 ${name}\n`);
          return 0;
        }
        if (sub === 'del') {
          const name = this.flagValue(args, '--name') ?? args[1];
          if (name === undefined) {
            throw new Error('vault del 需要 --name NAME');
          }
          const removed = await vault.deleteSecret(name);
          process.stdout.write(removed ? `已删除凭据 ${name}\n` : `(不存在: ${name})\n`);
          return removed ? 0 : 1;
        }
        if (sub === 'list') {
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
        void backendName;
      } finally {
        await vault.close();
      }
    } catch (error) {
      console.error(`凭据操作失败: ${messageOf(error)}`);
      return 1;
    }
    process.stdout.write(
      '用法: omniharness vault get|set|del|list [--name N] [--value V] [--vault-backend crypto|env] [--kv-adapter memory|json-file|sqlite] [--kv-file PATH] [--vault-key-file PATH]\n',
    );
    return 2;
  }

  /** 构建凭据保险库（默认 crypto + JSON KV；--vault-backend env 时走环境变量回退）。 */
  protected async buildVault(args: readonly string[]): Promise<VaultPort> {
    const backendIdx = args.findIndex((a) => a === '--vault-backend');
    const backend = backendIdx >= 0 ? args[backendIdx + 1] : 'crypto';
    if (backend === 'env') {
      return new EnvVault();
    }
    const keyFile = this.flagValue(args, '--vault-key-file');
    const kv = await this.buildKv(args);
    return new CryptoVault({ kv, keyFile });
  }

  /**
   * 插件集 Profile 子命令（#G-E / P5.1，对标 dsh 命名插件组合）：
   * profile list | profile create <name> [--desc D] [--plugin P ...] | profile delete <name> | profile use <name>。
   * `use` 把激活的 profile 名持久化到工作区配置，使后续 `serve` 默认收敛为该插件集。
   */
  protected async runProfile(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const wsRoot = this.flagValue(args, '--workspace') ?? process.cwd();
    const store = new PluginProfileStore(wsRoot);
    if (sub === 'list') {
      const all = store.list();
      if (all.length === 0) {
        process.stdout.write(
          '（无插件集 profile；用 profile create <name> --plugin P1 --plugin P2 创建）\n',
        );
        return 0;
      }
      for (const p of all) {
        process.stdout.write(
          `${p.name}\t${p.pluginCount} 插件${p.description !== undefined ? '\t' + p.description : ''}\n`,
        );
      }
      return 0;
    }
    if (sub === 'create') {
      const name = args[1];
      if (name === undefined) {
        process.stdout.write(
          '用法: omniharness profile create <name> [--desc D] [--plugin P ...]\n',
        );
        return 2;
      }
      const plugins = this.collectFlags(args, '--plugin');
      const desc = this.flagValue(args, '--desc');
      const id = store.save({
        name,
        plugins,
        ...(desc !== undefined ? { description: desc } : {}),
      });
      process.stdout.write(`已创建插件集 profile: ${name} (id=${id}, ${plugins.length} 插件)\n`);
      return 0;
    }
    if (sub === 'delete') {
      const name = args[1];
      if (name === undefined) {
        process.stdout.write('用法: omniharness profile delete <name>\n');
        return 2;
      }
      const removed = store.delete(sanitizeProfileName(name));
      process.stdout.write(
        removed ? `已删除插件集 profile: ${name}\n` : `（未找到 profile: ${name}）\n`,
      );
      return removed ? 0 : 1;
    }
    if (sub === 'use') {
      const name = args[1];
      if (name === undefined) {
        process.stdout.write('用法: omniharness profile use <name>\n');
        return 2;
      }
      const id = sanitizeProfileName(name);
      const profile = store.get(id);
      if (profile === undefined) {
        process.stderr.write(`未找到插件集 profile: ${name}\n`);
        return 1;
      }
      // 持久化到工作区配置，使后续 serve 默认应用该 profile（serve 读取 config.pluginProfile 作为 --plugin-profile 兜底）。
      const configPath = ConfigFile.find(wsRoot) ?? join(wsRoot, ConfigFile.FILE_NAME);
      const loaded = ConfigFile.load(configPath);
      ConfigFile.save(configPath, { ...loaded, pluginProfile: id });
      process.stdout.write(
        `已激活插件集 profile: ${name}（已写入 ${configPath}，下次 serve 将自动应用）\n`,
      );
      return 0;
    }
    process.stdout.write(
      '用法: omniharness profile list | profile create <name> [--desc D] [--plugin P ...] | profile delete <name> | profile use <name>\n',
    );
    return 2;
  }

  /**
   * Bundle 发布单元子命令（#G-E / P5.2，对标 dsh 可 patch 插件叠层 + 自包含发布单元）：
   * bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | bundle unpack <path.ohb> [--key-file K] [--dir P]。
   * `pack` 把命名插件集及其插件源封进 `.ohb`（零依赖 zip + 可选 HMAC 签名）；
   * `unpack` 还原插件到 pluginsDir 并写出补丁层（config 覆盖），使「用户覆盖层叠在 base 之上」真正可用。
   */
  protected async runBundle(args: readonly string[]): Promise<number> {
    const sub = args[0];
    const wsRoot = this.flagValue(args, '--workspace') ?? process.cwd();
    const pluginsDir = this.flagValue(args, '--dir') ?? join(homedir(), '.omniharness', 'plugins');
    if (sub === 'pack') {
      const name = args[1];
      if (name === undefined) {
        process.stdout.write(
          '用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P]\n',
        );
        return 2;
      }
      const store = new PluginProfileStore(wsRoot);
      const profile = store.get(sanitizeProfileName(name));
      if (profile === undefined) {
        process.stderr.write(`未找到插件集 profile: ${name}\n`);
        return 1;
      }
      const registry = this.createRegistry(args, pluginsDir);
      const keyFile = this.flagValue(args, '--key-file');
      const outDir = this.flagValue(args, '--out-dir');
      try {
        const result = await packBundle({
          workspaceDir: wsRoot,
          profile,
          registry,
          pluginsDir,
          ...(keyFile !== undefined ? { keyFile } : {}),
          ...(outDir !== undefined ? { outDir } : {}),
        });
        process.stdout.write(
          `已打包 bundle: ${result.path}（${result.manifest.plugins.length} 插件${result.manifest.signature !== undefined ? '，已签名' : ''}）\n`,
        );
        return 0;
      } catch (error) {
        console.error(`打包失败: ${messageOf(error)}`);
        return 1;
      }
    }
    if (sub === 'unpack') {
      const path = args[1];
      if (path === undefined) {
        process.stdout.write(
          '用法: omniharness bundle unpack <path.ohb> [--key-file K] [--dir P]\n',
        );
        return 2;
      }
      const keyFile = this.flagValue(args, '--key-file');
      try {
        const result = await unpackBundle({
          zipPath: path,
          pluginsDir,
          workspaceDir: wsRoot,
          ...(keyFile !== undefined ? { keyFile } : {}),
        });
        process.stdout.write(
          `已解包 bundle: ${result.manifest.name}（还原 ${result.installed.length} 插件，补丁层 ${result.patchFile}）\n`,
        );
        return 0;
      } catch (error) {
        console.error(`解包失败: ${messageOf(error)}`);
        return 1;
      }
    }
    process.stdout.write(
      '用法: omniharness bundle pack <profileName> [--key-file K] [--out-dir D] [--dir P] | bundle unpack <path.ohb> [--key-file K] [--dir P]\n',
    );
    return 2;
  }
}
