/**
 * 长时程任务的结构化状态件（2026-10-24，P0-2 / P1-2）。
 *
 * 解决的问题：长任务跨 context window 时，模型唯一能记住的只有「上下文里还在的东西」。
 * `ContextCompactor` 摘要能缓解，但摘要**不是状态**：它不知道「哪几条功能已经真的做完」，
 * 也无法阻止模型「过早宣布完成」或「重复做已经做完的部分」。
 *
 * 这里管理的是**磁盘上的三件套**（Anthropic 长时程 harness 的同一取向）：
 *  - `.omniharness/tasks/<slug>/features.json`：功能清单，每项带 `passes` 布尔（机械可勾选）；
 *  - `.omniharness/tasks/<slug>/progress.md`：append-only 进度（回合末写，不写回上下文）；
 *  - `.omniharness/tasks/<slug>/init.sh`（Windows 另有 `init.cmd`）：启动/验证入口。
 *
 * 三条硬约束：
 *  1. **路径越界 fail-closed**：slug 只允许 `^[a-z0-9][a-z0-9-]{0,63}$`；任何解析后落在任务目录
 *     之外的路径一律拒绝（不写、不读、不执行）。
 *  2. **空/损坏文件容错**：读永远不抛；损坏的 `features.json` 会被 `ensure()` 备份后重建，
 *     而不是让主流程崩掉。
 *  3. **零运行时依赖**：只用 node 内置模块（不引第三方、不新增 package.json 依赖）。
 *
 * 与上下文的关系：本类只提供**极简 primer**（当前任务 / 功能完成数 / 下一步 / 验证命令），
 * 不把 progress.md 或历史对话塞回上下文；完整进度是磁盘上的事实源，按需读取。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { VerifyCommandRunner, type VerifyCommandOutcome } from '../util/verifyCommandRunner.ts';

/** 功能清单里的一项。 */
export interface LongHorizonFeature {
  /** 稳定 id（`F1`、`F2`…；模型用 `markFeature` 勾选）。 */
  readonly id: string;
  /** 人类可读的功能描述（也用于 primer 的「下一步」）。 */
  readonly description: string;
  /** 是否已完成并通过验证。 */
  readonly passes: boolean;
}

/** 一次读取得到的状态快照（缺失/损坏也返回可用对象，不抛）。 */
export interface LongHorizonState {
  /** 任务 slug。 */
  readonly slug: string;
  /** 任务目录绝对路径（未初始化时是「将会创建」的路径）。 */
  readonly taskDir: string;
  /** 任务标题（首条提示的首行）。 */
  readonly title: string;
  /** 任务验证命令（未配置时为 undefined）。 */
  readonly verifyCommand: string | undefined;
  /** 功能清单（缺失/损坏时为空数组）。 */
  readonly features: readonly LongHorizonFeature[];
  /** `features.json` 是否存在且解析成功。 */
  readonly initialized: boolean;
  /** `features.json` 是否存在但内容损坏（`ensure()` 会备份并重建）。 */
  readonly corrupt: boolean;
  /** `progress.md` 当前字节数（缺失为 0）。 */
  readonly progressBytes: number;
}

/** `ensure()` 结果。 */
export interface LongHorizonEnsureResult {
  /** 状态件是否可用（slug 合法且目录可写）。 */
  readonly ok: boolean;
  /** 本次是否新建了 `features.json`。 */
  readonly created: boolean;
  /** 本次是否因损坏而重建（旧文件已备份）。 */
  readonly repaired: boolean;
  /** 失败原因（`ok:false` 时给出）。 */
  readonly reason: string | undefined;
  /** 确保后的状态快照。 */
  readonly state: LongHorizonState;
}

/** `markFeature()` 结果。 */
export interface LongHorizonFeatureResult {
  /** 是否更新成功。 */
  readonly ok: boolean;
  /** 更新后的功能项（失败时 undefined）。 */
  readonly feature: LongHorizonFeature | undefined;
  /** 失败原因。 */
  readonly reason: string | undefined;
}

/** `verify()` 结果（在通用命令结果上补充命令文本）。 */
export interface LongHorizonVerifyResult extends VerifyCommandOutcome {
  /** 实际执行的命令；未配置时为空串。 */
  readonly command: string;
}

/** `appendProgress()` 的结构化输入（字符串输入按「备注」处理）。 */
export interface LongHorizonProgressInput {
  /** 本轮用户提示（会压成一行并截断，避免 progress 被长 prompt 撑爆）。 */
  readonly userPrompt?: string | undefined;
  /** 本轮工具失败次数。 */
  readonly toolFailures?: number | undefined;
  /** 失败的工具名（可重复；最多记录 8 个）。 */
  readonly failedTools?: readonly string[] | undefined;
  /** 验证结论。 */
  readonly verify?: 'passed' | 'failed' | 'skipped' | 'not-run' | undefined;
  /** 验证细节（退出码/摘要）。 */
  readonly verifyDetail?: string | undefined;
  /** 追加备注（自由文本）。 */
  readonly note?: string | undefined;
  /** 记录时间（缺省当前时刻；测试可注入）。 */
  readonly at?: Date | undefined;
}

/** 构造参数。 */
export interface LongHorizonProtocolOptions {
  /** 工作区根：所有状态件只能落在它之下。 */
  readonly workspaceRoot: string;
  /** 任务 slug（必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`；不合法即 fail-closed）。 */
  readonly slug: string;
  /** 任务标题（缺省由 prompt 派生；只在新建 `features.json` 时写入）。 */
  readonly title?: string | undefined;
  /** 验证命令（缺省不配置；只在新建 `features.json` 时写入）。 */
  readonly verifyCommand?: string | undefined;
  /** 初始功能描述列表（缺省用「完成用户请求」一条）。 */
  readonly seedFeatures?: readonly string[] | undefined;
  /** 验证命令超时（毫秒，缺省 120s）。 */
  readonly verifyTimeoutMs?: number | undefined;
  /** 验证命令输出上限（字节，缺省 64KB）。 */
  readonly verifyMaxOutputBytes?: number | undefined;
  /** 可注入时钟（测试用；缺省 `Date.now`）。 */
  readonly now?: (() => number) | undefined;
}

/** `features.json` 的落盘形态（内部使用，读侧容错）。 */
interface FeaturesFile {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly title: string;
  readonly verifyCommand: string | undefined;
  readonly createdAt: string;
  readonly features: readonly LongHorizonFeature[];
}

/** 读 `features.json` 的原始结果。 */
interface FeaturesRead {
  readonly exists: boolean;
  readonly corrupt: boolean;
  readonly data: FeaturesFile | undefined;
}

/** 任务目录名（相对工作区）。 */
const TASKS_DIR = join('.omniharness', 'tasks');
/** 功能清单文件名。 */
const FEATURES_FILE = 'features.json';
/** 进度日志文件名。 */
const PROGRESS_FILE = 'progress.md';
/** POSIX 启动脚本文件名。 */
const INIT_SH = 'init.sh';
/** Windows 启动脚本文件名。 */
const INIT_CMD = 'init.cmd';
/** 落盘 schema 版本。 */
const SCHEMA_VERSION = 1;
/** slug 白名单（不含 `..` / 分隔符 / 绝对路径）。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** progress.md 体积上限：超过后保留后半段（append-only 不应无限增长）。 */
const MAX_PROGRESS_BYTES = 256 * 1024;
/** 验证结果复用窗口：同一回合内完成闸门与回合末记录共用一次命令执行。 */
const VERIFY_CACHE_TTL_MS = 60_000;
/** 单条用户提示写入 progress 的最大字符数。 */
const MAX_PROMPT_CHARS = 400;
/** 功能清单的初始条目上限。 */
const MAX_SEED_FEATURES = 8;

/** slug 是否安全。 */
export const isValidSlug = (slug: string): boolean => SLUG_PATTERN.test(slug);

/** 由会话 id 派生稳定 slug。 */
export const slugFor = (sessionId: string): string => {
  const cleaned = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, 48);
  return `sess-${cleaned === '' ? 'task' : cleaned}`;
};

/** 从提示取任务标题（首个非空行，去 markdown 标记，截断 80 字）。 */
export const titleOfPrompt = (prompt: string): string => {
  for (const raw of prompt.split(/\r?\n/u)) {
    const line = raw
      .trim()
      .replace(/^[#>*\s-]+/u, '')
      .trim();
    if (line !== '') return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }
  return '未命名任务';
};

/** 从提示列表项派生初始功能（去重、最多 8 条）。 */
export const seedFeaturesFromPrompt = (prompt: string): readonly string[] => {
  const items: string[] = [];
  for (const raw of prompt.split(/\r?\n/u)) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(raw);
    const text = match?.[1]?.trim();
    if (text === undefined || text === '') continue;
    const normalized = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    if (!items.includes(normalized)) items.push(normalized);
    if (items.length >= MAX_SEED_FEATURES) break;
  }
  return items.length > 0 ? items : [titleOfPrompt(prompt)];
};

/** 压成一行并截断。 */
export const oneLine = (text: string, limit: number): string => {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

/** 任务目录内路径（越界/未初始化返回 undefined）。 */
const taskPath = (directory: string, valid: boolean, name: string): string | undefined => {
  if (!valid) return undefined;
  const path = resolve(directory, name);
  const prefix = `${directory}${sep}`;
  return path.startsWith(prefix) ? path : undefined;
};

/**
 * 长时程任务状态协议（管理 features/progress/init 三件套）。
 */
export class LongHorizonProtocol {
  /** 工作区根（绝对路径）。 */
  private readonly workspaceRoot: string;
  /** 任务 slug。 */
  private readonly slug: string;
  /** 任务目录绝对路径（构造期计算并校验）。 */
  private readonly directory: string;
  /** slug 是否合法（不合法时全部写操作 fail-closed）。 */
  private readonly valid: boolean;
  /** 构造参数（保留 seed/title/verify 与可注入时钟）。 */
  private readonly options: LongHorizonProtocolOptions;
  /** 最近一次验证结果（回合内复用，避免同一命令跑两次）。 */
  private lastVerify: LongHorizonVerifyResult | undefined;
  /** 最近一次验证的时间戳（毫秒）。 */
  private lastVerifyAt = 0;

  /**
   * @param options 工作区、slug 与可选的标题/验证命令/初始功能。
   */
  public constructor(options: LongHorizonProtocolOptions) {
    this.options = options;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.slug = options.slug;
    this.valid = isValidSlug(options.slug);
    this.directory = this.valid ? join(this.workspaceRoot, TASKS_DIR, options.slug) : '';
  }

  /** 任务目录绝对路径（slug 不合法时为空串）。 */
  public get taskDir(): string {
    return this.directory;
  }

  /** slug 是否合法（不合法时所有状态件操作 fail-closed）。 */
  public get available(): boolean {
    return this.valid;
  }

  /**
   * 确保状态件存在（幂等）：缺失即创建，损坏即备份后重建。
   * @returns 创建/修复结果与状态快照；slug 不合法或写盘失败时 `ok:false`。
   */
  public ensure(): LongHorizonEnsureResult {
    if (!this.valid) {
      return {
        ok: false,
        created: false,
        repaired: false,
        reason: `非法任务 slug（拒绝路径越界）：${this.slug}`,
        state: this.read(),
      };
    }
    try {
      mkdirSync(this.directory, { recursive: true });
      const raw = this.readFeaturesFile();
      if (raw.corrupt) this.backupCorrupt();
      if (!raw.exists || raw.corrupt || raw.data === undefined) {
        this.writeFeatures(this.defaultFeatures());
      }
      this.ensureFile(PROGRESS_FILE, `# 进度日志：${this.slug}\n\n`);
      this.ensureScripts();
      return {
        ok: true,
        created: !raw.exists,
        repaired: raw.corrupt,
        reason: undefined,
        state: this.read(),
      };
    } catch (error) {
      return {
        ok: false,
        created: false,
        repaired: false,
        reason: error instanceof Error ? error.message : String(error),
        state: this.read(),
      };
    }
  }

  /**
   * 读取状态（永远不抛：缺失/损坏/越界都返回可用快照）。
   * @returns 状态快照。
   */
  public read(): LongHorizonState {
    const raw = this.valid ? this.readFeaturesFile() : undefined;
    const data = raw?.data;
    const features = data?.features ?? [];
    const title = data?.title ?? this.options.title ?? '';
    const verifyCommand =
      data?.verifyCommand ??
      (this.options.verifyCommand !== undefined && this.options.verifyCommand !== ''
        ? this.options.verifyCommand
        : undefined);
    return {
      slug: this.slug,
      taskDir: this.directory,
      title,
      verifyCommand,
      features,
      initialized: data !== undefined,
      corrupt: raw?.corrupt === true,
      progressBytes: this.progressBytes(),
    };
  }

  /**
   * 渲染**极简** primer（当前任务 / 功能完成数 / 下一步 / 验证命令）。
   *
   * 刻意不包含 progress.md 全文与历史：长会话的上下文腐烂来自「把一切塞回去」，
   * 这里只给模型四条可执行事实。
   * @returns primer 文本；未初始化（无 features.json）时为空串。
   */
  public renderPrimer(): string {
    const state = this.read();
    if (!state.initialized) {
      return '';
    }
    const total = state.features.length;
    const done = state.features.filter((feature) => feature.passes).length;
    const next = state.features.find((feature) => !feature.passes);
    const nextStep =
      next === undefined
        ? '全部功能已勾选；做最后一次验证并如实报告'
        : `${next.id} · ${next.description}`;
    return [
      `【长时程任务】${state.slug}${state.title === '' ? '' : ` · ${state.title}`}`,
      `功能: ${String(done)}/${String(total)} 已完成 · 下一步: ${nextStep}`,
      `验证: ${state.verifyCommand ?? '未配置（用你自建的测试/脚本验证）'}`,
      `状态件: .omniharness/tasks/${state.slug}/（features.json / progress.md / init.sh）；逐项确认后再宣告完成。`,
    ].join('\n');
  }

  /**
   * 追加一条进度（append-only；文件过大时保留后半段）。
   * @param entry 结构化进度或一段备注文本。
   * @returns 写入成功为 true（slug 不合法/写盘失败为 false，不抛）。
   */
  public appendProgress(entry: LongHorizonProgressInput | string): boolean {
    if (!this.valid) {
      return false;
    }
    try {
      mkdirSync(this.directory, { recursive: true });
      const path = taskPath(this.directory, this.valid, PROGRESS_FILE);
      if (path === undefined) return false;
      this.trimProgressIfNeeded(path);
      appendFileSync(path, this.formatProgress(entry), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 勾选/取消勾选一条功能（原子写回 features.json）。
   * @param featureId 功能 id（如 `F1`）。
   * @param passes 是否完成。
   * @returns 更新结果；文件缺失/损坏/未知 id 时 `ok:false`（fail-closed，不猜）。
   */
  public markFeature(featureId: string, passes: boolean): LongHorizonFeatureResult {
    const raw = this.valid ? this.readFeaturesFile() : undefined;
    const data = raw?.data;
    if (data === undefined) {
      return { ok: false, feature: undefined, reason: 'features.json 缺失或损坏（先执行 ensure）' };
    }
    const index = data.features.findIndex((feature) => feature.id === featureId);
    if (index < 0) {
      return { ok: false, feature: undefined, reason: `未知功能 id：${featureId}` };
    }
    const features = data.features.map((feature, i) =>
      i === index ? { ...feature, passes } : feature,
    );
    try {
      this.writeFeatures({ ...data, features });
      return { ok: true, feature: features[index], reason: undefined };
    } catch (error) {
      return {
        ok: false,
        feature: undefined,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 跑一次任务验证命令（结果在 60s 内复用；`force` 可强制重跑）。
   * @param options `force:true` 跳过缓存。
   * @returns 验证结果；未配置命令时 `ran:false`（不臆造通过）。
   */
  public async verify(
    options: { readonly force?: boolean | undefined } = {},
  ): Promise<LongHorizonVerifyResult> {
    const state = this.read();
    if (state.verifyCommand === undefined) {
      return {
        command: '',
        ran: false,
        ok: false,
        exitCode: null,
        output: '',
        timedOut: false,
        truncated: false,
        error: '未配置 verifyCommand',
      };
    }
    const now = this.options.now?.() ?? Date.now();
    if (
      options.force !== true &&
      this.lastVerify !== undefined &&
      now - this.lastVerifyAt < VERIFY_CACHE_TTL_MS
    ) {
      return this.lastVerify;
    }
    const outcome = await VerifyCommandRunner.run(
      state.verifyCommand,
      this.workspaceRoot,
      this.options.verifyTimeoutMs ?? VerifyCommandRunner.DEFAULT_TIMEOUT_MS,
      this.options.verifyMaxOutputBytes ?? VerifyCommandRunner.DEFAULT_MAX_OUTPUT_BYTES,
    );
    const result: LongHorizonVerifyResult = { ...outcome, command: state.verifyCommand };
    this.lastVerify = result;
    this.lastVerifyAt = now;
    return result;
  }

  /** progress.md 当前字节数（读失败按 0）。     * @returns 返回值。
   */
  private progressBytes(): number {
    const path = taskPath(this.directory, this.valid, PROGRESS_FILE);
    if (path === undefined || !existsSync(path)) return 0;
    try {
      // 只取字节数用 stat（2026-10-27 审计收口）：此前为拿长度把整个 progress.md 同步
      // 读进内存——appendProgress 每次追加都先走这里，长任务高频追加时是 O(N) 重复
      // 全量读，放大事件循环延迟。
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  /**
   * 读 features.json（BOM/坏 JSON/形状不符都收敛为 `corrupt:true`，不抛）。
   * @returns 原始读取结果。
   */
  private readFeaturesFile(): FeaturesRead {
    const path = taskPath(this.directory, this.valid, FEATURES_FILE);
    if (path === undefined || !existsSync(path)) {
      return { exists: false, corrupt: false, data: undefined };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
    } catch {
      return { exists: true, corrupt: true, data: undefined };
    }
    const data = this.parseFeaturesFile(parsed);
    return data === undefined
      ? { exists: true, corrupt: true, data: undefined }
      : { exists: true, corrupt: false, data };
  }

  /**
   * 校验 features.json 形状（任何一项不合法即整体判损坏，避免半读状态）。
   * @param raw 解析后的 JSON。
   * @returns 规范化数据；形状不符为 undefined。
   */
  private parseFeaturesFile(raw: unknown): FeaturesFile | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const list = record['features'];
    if (!Array.isArray(list)) return undefined;
    const features: LongHorizonFeature[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
      const entry = item as Record<string, unknown>;
      const id = entry['id'];
      const description = entry['description'];
      if (typeof id !== 'string' || id === '') return undefined;
      if (typeof description !== 'string') return undefined;
      features.push({ id, description, passes: entry['passes'] === true });
    }
    const verifyCommand = record['verifyCommand'];
    return {
      schemaVersion:
        typeof record['schemaVersion'] === 'number' ? record['schemaVersion'] : SCHEMA_VERSION,
      slug: this.slug,
      title: typeof record['title'] === 'string' ? record['title'] : '',
      verifyCommand:
        typeof verifyCommand === 'string' && verifyCommand !== '' ? verifyCommand : undefined,
      createdAt:
        typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date().toISOString(),
      features,
    };
  }

  /** 新建 features.json 用的默认数据。     * @returns 返回值。
   */
  private defaultFeatures(): FeaturesFile {
    const promptSeeds = this.options.seedFeatures ?? ['完成用户请求'];
    const seeds =
      promptSeeds.length > 0 ? promptSeeds.slice(0, MAX_SEED_FEATURES) : ['完成用户请求'];
    const now = this.options.now?.() ?? Date.now();
    return {
      schemaVersion: SCHEMA_VERSION,
      slug: this.slug,
      title: this.options.title ?? '',
      verifyCommand:
        this.options.verifyCommand !== undefined && this.options.verifyCommand !== ''
          ? this.options.verifyCommand
          : undefined,
      createdAt: new Date(now).toISOString(),
      features: seeds.map((description, index) => ({
        id: `F${String(index + 1)}`,
        description,
        passes: false,
      })),
    };
  }

  /**
   * 原子写 features.json（先写临时文件再 rename，避免半截 JSON）。
   * @param data 要写入的数据。
   * @returns 无返回值。
   */
  private writeFeatures(data: FeaturesFile): void {
    const path = taskPath(this.directory, this.valid, FEATURES_FILE);
    if (path === undefined) throw new Error('features.json 路径越界（fail-closed）');
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  /**
   * 备份损坏的 features.json（保留证据，再重建）。
   * @returns 无返回值。
   */
  private backupCorrupt(): void {
    const path = taskPath(this.directory, this.valid, FEATURES_FILE);
    if (path === undefined || !existsSync(path)) return;
    try {
      const stamp = new Date(this.options.now?.() ?? Date.now())
        .toISOString()
        .replace(/[:.]/gu, '-');
      renameSync(path, `${path}.corrupt-${stamp}`);
    } catch {
      /* 备份失败不阻断修复：ensure 仍会写新文件 */
    }
  }

  /**
   * 创建缺失的启动脚本（已存在不覆盖，保留用户手改）。
   * @returns 无返回值。
   */
  private ensureScripts(): void {
    const verify = this.read().verifyCommand;
    const shPath = taskPath(this.directory, this.valid, INIT_SH);
    if (shPath !== undefined && !existsSync(shPath)) {
      writeFileSync(shPath, this.initScript(verify), { encoding: 'utf8', mode: 0o755 });
    }
    const cmdPath = taskPath(this.directory, this.valid, INIT_CMD);
    if (cmdPath !== undefined && !existsSync(cmdPath)) {
      writeFileSync(cmdPath, this.initCommand(verify), 'utf8');
    }
  }

  /**
   * 生成 POSIX 启动脚本内容。
   * @param verify 验证命令（未配置时写一行说明）。
   * @returns 脚本文本。
   */
  private initScript(verify: string | undefined): string {
    return [
      '#!/usr/bin/env bash',
      `# 长时程任务启动/验证脚本（由 LongHorizonProtocol 生成；可手改，缺失时自动重建）`,
      'set -euo pipefail',
      'cd "$(dirname "$0")/../../.."',
      `echo "task: ${this.slug}"`,
      verify ?? 'echo "未配置 verifyCommand（用项目自带测试/脚本验证）"',
      '',
    ].join('\n');
  }

  /**
   * 生成 Windows 启动脚本内容（`init.cmd`）。
   * @param verify 验证命令（未配置时写一行说明）。
   * @returns 脚本文本。
   */
  private initCommand(verify: string | undefined): string {
    return [
      '@echo off',
      'rem 长时程任务启动/验证脚本（由 LongHorizonProtocol 生成；可手改，缺失时自动重建）',
      'cd /d "%~dp0\\..\\..\\.."',
      `echo task: ${this.slug}`,
      verify ?? 'echo 未配置 verifyCommand（用项目自带测试/脚本验证）',
      '',
    ].join('\r\n');
  }

  /**
   * 确保某个状态文件存在（缺失时写入默认内容）。
   * @param name 文件名。
   * @param initial 初始内容。
   * @returns 无返回值。
   */
  private ensureFile(name: string, initial: string): void {
    const path = taskPath(this.directory, this.valid, name);
    if (path === undefined || existsSync(path)) return;
    writeFileSync(path, initial, 'utf8');
  }

  /**
   * progress.md 超过上限时保留后半段（从之后的第一个 `## ` 起），避免无限增长。
   * @param path progress.md 绝对路径。
   * @returns 无返回值。
   */
  private trimProgressIfNeeded(path: string): void {
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') <= MAX_PROGRESS_BYTES) return;
    const cut = text.indexOf('\n## ', Math.floor(text.length / 2));
    const kept = cut < 0 ? text.slice(-Math.floor(MAX_PROGRESS_BYTES / 2)) : text.slice(cut + 1);
    writeFileSync(path, `# 进度日志：${this.slug}（较早记录已裁剪）\n\n${kept}`, 'utf8');
  }

  /**
   * 把结构化输入格式化为 markdown 段。
   * @param entry 结构化进度或备注字符串。
   * @returns 追加文本（以 `## ` 标题开头）。
   */
  private formatProgress(entry: LongHorizonProgressInput | string): string {
    if (typeof entry === 'string') {
      return `## ${new Date(this.options.now?.() ?? Date.now()).toISOString()}\n- 备注: ${oneLine(entry, MAX_PROMPT_CHARS)}\n`;
    }
    const at = entry.at ?? new Date(this.options.now?.() ?? Date.now());
    const lines = [`## ${at.toISOString()}`];
    if (entry.userPrompt !== undefined && entry.userPrompt.trim() !== '') {
      lines.push(`- 用户提示: ${oneLine(entry.userPrompt, MAX_PROMPT_CHARS)}`);
    }
    if (entry.toolFailures !== undefined) {
      const names =
        entry.failedTools === undefined || entry.failedTools.length === 0
          ? ''
          : `（${entry.failedTools.slice(0, 8).join(', ')}）`;
      lines.push(`- 工具失败: ${String(entry.toolFailures)}${names}`);
    }
    if (entry.verify !== undefined) {
      const detail =
        entry.verifyDetail === undefined || entry.verifyDetail === ''
          ? ''
          : `（${oneLine(entry.verifyDetail, 160)}）`;
      lines.push(`- 验证: ${entry.verify}${detail}`);
    }
    if (entry.note !== undefined && entry.note.trim() !== '') {
      lines.push(`- 备注: ${oneLine(entry.note, MAX_PROMPT_CHARS)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
