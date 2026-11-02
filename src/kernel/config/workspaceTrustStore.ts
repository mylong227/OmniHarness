/**
 * 工作区信任存储（用户级 `~/.omniharness/trust.json`）。
 *
 * 设计约束：
 * - **只写用户级**：信任决定不能落在工作区（否则与「未信任工作区」自相矛盾）；
 * - **TOFU + 指纹**：条目键 = 工作区 realpath，值 = `{ configHash, trustedAt }`；
 *   项目配置/profile/bundle patch 任一内容变化 ⇒ 指纹不匹配 ⇒ 回到 restricted；
 * - **有界**：最多 {@link MAX_ENTRIES} 条，按 `trustedAt` 淘汰最旧，避免长期运行无限增长；
 * - **原子写**：临时文件 + rename，`0600`；损坏的 trust.json 不阻断启动，按「无信任」处理并告警。
 *
 * 诚实边界：这不是「防篡改」存储——能改用户级文件的人已经拥有该用户权限。它防的是
 * 「clone 下来的仓库配置」在未确认时被执行，不是防本机恶意软件。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TextBom } from '../util/textBom.ts';
import { OmniHome } from '../util/omniHome.ts';

/** 信任条目上限（超出按 trustedAt 淘汰最旧）。 */
export const MAX_TRUST_ENTRIES = 100;

/** 单个信任条目。 */
interface TrustEntry {
  /** 工作区配置指纹（sha256）。 */
  readonly configHash: string;
  /** 授权时间（ISO）。 */
  readonly trustedAt: string;
}

/** trust.json 的磁盘形态。 */
interface TrustFile {
  readonly version: 1;
  readonly workspaces: Record<string, TrustEntry>;
}

/** 读取结果：条目表 + 告警（损坏时为空表）。 */
interface LoadResult {
  readonly workspaces: Record<string, TrustEntry>;
  readonly warnings: readonly string[];
}

/**
 * 用户级工作区信任存储（无状态 IO，实例只承载路径）。
 */
export class WorkspaceTrustStore {
  /** trust.json 绝对路径。 */
  public readonly path: string;

  /**
   * @param home 用户家目录（**测试隔离注入**；缺省走归属根裁决——显式注入压过 `OMNI_HOME`，
   *   见 `OmniHome` 的优先级说明）。
   */
  public constructor(home?: string) {
    this.path = join(OmniHome.dir(home), 'trust.json');
  }

  /**
   * 判断工作区是否已被信任，且指纹仍匹配。
   * @param workspace 工作区路径（内部做 resolve，调用方无需预规范化）。
   * @param configHash 当前配置指纹。
   * @returns 命中且指纹一致为 true。
   */
  public isTrusted(workspace: string, configHash: string): boolean {
    return this.check(workspace, configHash).trusted;
  }

  /**
   * 判断信任状态并带上存储告警（损坏/不可读时告警必须能到达 CLI）。
   * @param workspace 工作区路径。
   * @param configHash 当前配置指纹。
   * @returns 命中结果与告警。
   */
  public check(
    workspace: string,
    configHash: string,
  ): { readonly trusted: boolean; readonly warnings: readonly string[] } {
    const key = WorkspaceTrustStore.normalize(workspace);
    const loaded = this.load();
    const entry = loaded.workspaces[key];
    return {
      trusted: entry !== undefined && entry.configHash === configHash,
      warnings: loaded.warnings,
    };
  }

  /**
   * 记录/更新信任条目（原子写；有界）。
   * @param workspace 工作区路径。
   * @param configHash 当前配置指纹。
   * @param now 授权时间（测试注入受控时钟；缺省墙钟）。
   * @returns 写入是否成功 + 告警（失败时调用方必须按未信任处理）。
   */
  public grant(
    workspace: string,
    configHash: string,
    now: Date = new Date(),
  ): { readonly ok: boolean; readonly warnings: readonly string[] } {
    const key = WorkspaceTrustStore.normalize(workspace);
    const loaded = this.load();
    const workspaces: Record<string, TrustEntry> = { ...loaded.workspaces };
    workspaces[key] = { configHash, trustedAt: now.toISOString() };
    const bounded = WorkspaceTrustStore.bound(workspaces);
    try {
      this.write(bounded);
      return { ok: true, warnings: loaded.warnings };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        warnings: [...loaded.warnings, `trust.json 写入失败（本次按未信任处理）：${reason}`],
      };
    }
  }

  /**
   * 读取条目表；文件缺失/损坏均返回空表（fail-closed 到「未信任」）。
   * @returns 条目表与告警。
   */
  public load(): LoadResult {
    if (!existsSync(this.path)) {
      return { workspaces: {}, warnings: [] };
    }
    let raw: string;
    try {
      raw = TextBom.strip(readFileSync(this.path, 'utf8'));
    } catch (error) {
      return {
        workspaces: {},
        warnings: [`trust.json 不可读（按未信任处理）：${String(error)}`],
      };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TrustFile>;
      if (parsed.version !== undefined && parsed.version !== 1) {
        return {
          workspaces: {},
          warnings: [`trust.json 版本 ${String(parsed.version)} 不认识（按未信任处理）`],
        };
      }
      return {
        workspaces: WorkspaceTrustStore.bound(WorkspaceTrustStore.sanitize(parsed.workspaces)),
        warnings: [],
      };
    } catch (error) {
      return {
        workspaces: {},
        warnings: [
          `trust.json 已损坏（按未信任处理；可用 --trust-workspace 重建）：${String(error)}`,
        ],
      };
    }
  }

  /**
   * 把工作区路径规范化为 realpath（失败回退 resolve）。
   * @param workspace 工作区路径。
   * @returns 绝对路径。
   */
  public static normalize(workspace: string): string {
    try {
      return realpathSync.native(workspace);
    } catch {
      return resolve(workspace);
    }
  }

  /**
   * 淘汰最旧条目，保证条目数 ≤ {@link MAX_TRUST_ENTRIES}。
   * @param workspaces 条目表。
   * @returns 有界条目表。
   */
  private static bound(workspaces: Record<string, TrustEntry>): Record<string, TrustEntry> {
    const entries = Object.entries(workspaces);
    if (entries.length <= MAX_TRUST_ENTRIES) {
      return workspaces;
    }
    entries.sort((a, b) => a[1].trustedAt.localeCompare(b[1].trustedAt));
    return Object.fromEntries(entries.slice(entries.length - MAX_TRUST_ENTRIES));
  }

  /**
   * 过滤磁盘上的未知/非法条目（防手改 trust.json 注入奇怪对象）。
   * @param value 原始 workspaces 字段。
   * @returns 合法条目表。
   */
  private static sanitize(value: unknown): Record<string, TrustEntry> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {};
    }
    const out: Record<string, TrustEntry> = Object.create(null) as Record<string, TrustEntry>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // 防原型污染：JSON.parse 可产出 `"__proto__"` 自有属性，赋值到普通对象会改原型。
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record['configHash'] !== 'string' || typeof record['trustedAt'] !== 'string') {
        continue;
      }
      out[key] = { configHash: record['configHash'], trustedAt: record['trustedAt'] };
    }
    return out;
  }

  /**
   * 原子写入 trust.json（临时文件 + rename；0600）。
   * @param workspaces 条目表。
   * @returns 无返回值。
   */
  private write(workspaces: Record<string, TrustEntry>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    WorkspaceTrustStore.sweepStaleTemps(dir, this.path);
    const payload: TrustFile = { version: 1, workspaces };
    const tmp = `${this.path}.tmp-${String(process.pid)}-${String(Date.now())}`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmp, this.path);
    } catch (error) {
      // 临时文件可能残留；尽力清掉，避免长期运行积累垃圾。
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 清理失败不掩盖原始错误。
      }
      throw error;
    }
  }

  /**
   * 清理本进程之外的陈旧临时文件（崩溃/强杀留下的 `trust.json.tmp-*`）。
   * 只删超过 1 小时的，避免误删另一个正在写入的进程的临时文件。
   * @param dir 目录。
   * @param target 主文件路径（用于匹配前缀）。
   * @returns 无返回值。
   */
  private static sweepStaleTemps(dir: string, target: string): void {
    const prefix = `${target.split(/[\\/]/u).pop() ?? ''}.tmp-`;
    const cutoff = Date.now() - 60 * 60 * 1000;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
        }
      } catch {
        // 另一个进程可能刚删除/占用；忽略。
      }
    }
  }
}
