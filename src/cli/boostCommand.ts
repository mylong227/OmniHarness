/**
 * `boost` 子命令 —— 把「探针读数」与「门禁挑选」纳入 harness 自身（不再依赖任何仓库外的脚本）。
 *
 * ## 回答什么问题
 *
 * 两件此前只活在终端滚动缓冲里的事：
 *
 * 1. **探针**：`tools/probes/` 的 8 个探针各自能跑，但没人负责"把这一轮跑齐、归档读数与退出码、
 *    并跟上一次比"。跨次对比靠人眼；`3`/`4`（判据无区分力 / 纪律违规）被当失败而埋掉真实发现。
 * 2. **门禁**：`scripts/runGates.mjs` 每次全量跑（`fast` 层实测 ~60s），而多数改动只碰一两个文件。
 *    本命令按改动挑子集，并**逐条打印"为什么跑/为什么不跑"**。
 *
 * ## 铁律（本模块的每一行都要能对上其中一条）
 *
 * - **门禁清单不是本模块的真相**：全部 id 与分层由 `scripts/runGates.mjs --list` **现场读出**；
 *   子集通过 `--only=<id,...> --tier=<层>` 交回**同一个实现**执行。绝不硬编码第二份清单。
 * - **兜底集常驻**：`node-engine` / `iron-law` / `maturity` / `standard-delta` / `arch` 在任何改动下
 *   都可能因"本次提交内容"变红，**永不跳过**（`standard-delta` 就是"禁止本次提交新增违规"）。
 * - **新门禁 ⇒ 自动失效**：上游出现本模块规则表不可达的 gate id ⇒ 不猜，转全量并说明是哪一条。
 * - **未知路径 ⇒ 全量**：分类不出来的文件一律不跳过。
 * - **禁"少跑还算通过"**：只跑子集时的措辞是「子集门禁通过（跑了 N/M 条）」，**不写**"门禁通过"；
 *   不执行时退出码 **3**（需人工/全量核验），不伪装成通过。
 * - **退出码是数据不是布尔**：探针 `2` = 仪器坏（`exitCode` 1）、`3`/`4` = 结论（`exitCode` 3）、
 *   全通过 = 0。把结论压成"失败"会让"判据没有区分力"被当成故障去修。
 *
 * ## 诚实边界
 *
 * - 规则表分类的是「**这种文件类型可能触发哪些门禁**」，**不是**对每条门禁输入集的证明。
 *   `scripts/auditStandards.mjs --maturity` 会顺着源码里的 `@maturityEvidence` 去读 `tests/**`——
 *   这类"顺着声明读别的路径"的情形说明**推理会漏**，故未知类型一律转全量，且兜底集不参与剪裁。
 * - 探针归档里的 `gitCommit` 只是**线索**：`src/` 每加一个文件都会改变召回类探针的读数，
 *   两次读数可比的前提是**同语料**，本模块不做语料指纹（未实现，不假装有）。
 * - 子进程超时只杀直接子进程（Node 语义）；探针是短命进程，故未做进程树清理，此处如实登记。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  BoostProbes,
  PROBES_DIR,
  PROBE_META,
  type BoostDiffEntry,
  type BoostProbeRecord,
  type BoostProbeRun,
} from './boostProbes.js';
import { BoostGateSurface } from './boostGateSurface.js';
import { BoostSurfaceAudit, SURFACE_SNAPSHOT_REL } from './boostSurfaceAudit.js';

/** 归档根（仓库内、运行时产物；与 `.omniharness/` 同类，不入库）。 */
const DEFAULT_OUT_DIR = join('.omniharness', 'boost');

/** 门禁唯一实现的入口（相对仓库根）。 */
const GATES_SCRIPT = 'scripts/runGates.mjs';

/** 单探针超时缺省值（30 分钟：够 `semanticHybridRecall` 首跑拉权重 + 千文件索引）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 1_800_000;

/** 一条门禁的定义（**来自 `runGates.mjs --list` 的现场输出**）。 */
export interface BoostGateInfo {
  /** 门禁 id。 */
  readonly id: string;
  /** 分层（`fast` / `typed`）。 */
  readonly tier: string;
  /** 人类可读标签。 */
  readonly label: string;
}

/** 门禁挑选结论。 */
export interface BoostGateDecision {
  /** 本次要跑的门禁 id（保持 `runGates.mjs` 顺序）。 */
  readonly selected: readonly string[];
  /** 逐条理由（键 = 门禁 id）。 */
  readonly reasons: Readonly<Record<string, string>>;
  /** 转全量的原因（`null` = 走规则表判定）。 */
  readonly fallback: string | null;
  /** 规则表覆盖不到的文件（非空 ⇒ 必然转全量）。 */
  readonly unmatched: readonly string[];
  /** 本次层内门禁数。 */
  readonly inTier: number;
  /** 全部门禁数。 */
  readonly allGates: number;
}

/** `boost probe` / `boost gate` 的命令行选项（由 `cliDataCmds` 的字面量读取组装）。 */
export interface BoostOptions {
  /** 子动作：`probe` / `gate`。 */
  readonly action: string;
  /** 只列不跑。 */
  readonly list: boolean;
  /** 探针名（逗号分隔后的结果；空 ⇒ 默认跑集）。 */
  readonly probes: readonly string[];
  /** 定向追加给**单个**探针的参数。 */
  readonly args: readonly string[];
  /** 是否纳入需网络的探针。 */
  readonly network: boolean;
  /** 是否与上一轮比对。 */
  readonly diff: boolean;
  /** 门禁层（`fast` / `typed` / `all`）。 */
  readonly tier: string;
  /** 改动来源（`staged` / `worktree`）。 */
  readonly mode: string;
  /** 是否真的执行门禁子集。 */
  readonly run: boolean;
  /** 是否逐条打印理由。 */
  readonly explain: boolean;
  /** 归档/结论输出路径覆盖（仓库根相对）。 */
  readonly outDir?: string;
  /** 单探针超时（毫秒）。 */
  readonly timeoutMs: number;
}

/** `boost` 子命令实现。 */
export class BoostCommand {
  /**
   * @param root 仓库根绝对路径（CLI 传 `process.cwd()`；测试传临时目录）。
   */
  public constructor(private readonly root: string) {}

  /**
   * 本地时间戳目录名（字典序 = 时间序；实现见 `boostProbes.ts`）。
   * @param now 时间点（缺省当前）。
   * @returns `YYYYMMDD-HHmmss`。
   */
  private static stamp(now: Date = new Date()): string {
    return BoostProbes.stamp(now);
  }

  /**
   * 相对仓库根的正斜杠路径（归档里一律用这种形式，跨平台可比）。
   * @param abs 绝对路径。
   * @returns 仓库根相对路径。
   */
  private rel(abs: string): string {
    const r = relative(this.root, abs).replaceAll('\\', '/');
    // 归档根被 `--boost-dir` 指到仓库外时，`relative` 会产出 `../../..` 这类越界串——
    // 打印它既不可读、也无法直接粘进命令。越界就如实给绝对路径。
    return r.startsWith('..') ? abs.replaceAll('\\', '/') : r;
  }

  /**
   * 把 `--boost-dir DIR` 解析为绝对路径：**绝对路径原样用，相对路径相对仓库根**。
   *
   * 单一实现（原先三处各自 `join(this.root, outDir)`，绝对路径会被拼成
   * `D:\repo\C:\Users\…` 这种既不存在也不可读的路径——2026-10-11 由新增的 CLI 判据当场抓到：
   * `--boost-dir <绝对临时目录>` 报 `ENOENT: mkdir 'D:\…\C:\Users\…'`）。
   * @param dir 命令行给的目录（`undefined` 表示用默认相对路径）。
   * @param fallbackRel 默认相对路径（相对仓库根）。
   * @returns 绝对路径。
   */
  private outDirAbs(dir: string | undefined, fallbackRel: string): string {
    const raw = dir ?? fallbackRel;
    return isAbsolute(raw) ? raw : join(this.root, raw);
  }

  /**
   * 归档根绝对路径（`--boost-dir DIR` 可覆盖）。
   * @param options 命令行选项。
   * @returns 归档根绝对路径。
   */
  private outRoot(options: BoostOptions): string {
    return this.outDirAbs(options.outDir, DEFAULT_OUT_DIR);
  }

  /**
   * 发现探针（委托 `BoostProbes.discover`；`_` 前缀是共享模块，不是探针）。
   * @param root 仓库根绝对路径。
   * @returns 按名排序的探针名。
   */
  public static discoverProbes(root: string): readonly string[] {
    return BoostProbes.discover(root);
  }

  /**
   * 默认跑集（委托 `BoostProbes.defaultSelection`：只认**登记过**且不标 `network` 的探针）。
   * @param all 全部探针名。
   * @param network 是否纳入需网络的探针。
   * @returns 默认跑集。
   */
  public static defaultSelection(all: readonly string[], network: boolean): readonly string[] {
    return BoostProbes.defaultSelection(all, network);
  }

  /**
   * 退出码 → 可信度分类（委托 `BoostProbes.classifyExit`）。
   * @param status 退出码；`null` = 超时或被信号杀死。
   * @param timedOut 是否超时。
   * @param meta 探针元数据（决定哪些退出码算"结论"）。
   * @returns 分类。
   */
  public static classifyExit(
    status: number | null,
    timedOut: boolean,
    meta?: { measurementExitCodes?: readonly number[] },
  ): 'ok' | 'instrument' | 'measurement' {
    return BoostProbes.classifyExit(status, timedOut, meta);
  }

  /**
   * 收集报告里的标量叶子（委托 `BoostProbes.collectScalars`）。
   * @param node 当前节点。
   * @param prefix 键路径前缀。
   * @param out 收集结果（就地写入）。
   * @returns 无返回值。
   */
  public static collectScalars(
    node: unknown,
    prefix: string,
    out: Record<string, number | boolean>,
  ): void {
    BoostProbes.collectScalars(node, prefix, out);
  }

  /**
   * 比对两轮读数（委托 `BoostProbes.diff`：**数字变了**与**口径变了**分开报）。
   * @param current 本轮。
   * @param baseline 基线。
   * @returns 差异条目。
   */
  public static diff(current: BoostProbeRun, baseline: BoostProbeRun): readonly BoostDiffEntry[] {
    return BoostProbes.diff(current, baseline);
  }

  /**
   * 现场读出门禁清单（唯一真相 = `scripts/runGates.mjs --list`）。
   * @returns 门禁清单；读不出返回空数组（由调用方 fail-closed）。
   */
  public readGates(): readonly BoostGateInfo[] {
    const r = spawnSync(process.execPath, [GATES_SCRIPT, '--list'], {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error !== undefined || r.status !== 0) return [];
    const gates: BoostGateInfo[] = [];
    for (const line of String(r.stdout).split('\n')) {
      const m = /^\s{2}(\S+)\s+\[(\w+)\]\s+(.*)$/.exec(line);
      if (m !== null) gates.push({ id: m[1] ?? '', tier: m[2] ?? '', label: (m[3] ?? '').trim() });
    }
    return gates;
  }

  /**
   * 按改动挑选门禁子集（**纯函数**：便于机械验证）。
   *
   * 判定完全由 `boostGateSurface.ts` 的**取证过**的表面声明驱动：改动碰到某门禁的任一输入 ⇒ 必须跑；
   * 未声明或未取证 ⇒ 永不跳过。本函数只做"选谁"，不做"猜它的输入是什么"。
   * @param gates 全部门禁（现场读出）。
   * @param files 改动文件（仓库根相对，正斜杠）。
   * @param tier 目标层。
   * @returns 判定结论。
   */
  public static decide(
    gates: readonly BoostGateInfo[],
    files: readonly string[],
    tier: string,
  ): BoostGateDecision {
    const normalized = files.map((f) => f.replaceAll('\\', '/'));
    const tierWanted = new Set(tier === 'all' ? ['fast', 'typed'] : [tier]);
    const inTierGates = gates.filter((g) => tierWanted.has(g.tier));
    /** 逐条门禁的命中情况（不可跳过者一律 hit=true，见 `touchesSurface`）。 */
    const touched = new Map(
      gates.map((g) => [g.id, BoostGateSurface.touches(g.id, normalized)] as const),
    );
    const undeclared = gates.filter((g) => !touched.get(g.id)?.skippable).map((g) => g.id);
    const hitInTier = inTierGates.filter((g) => touched.get(g.id)?.hit === true);
    let fallback: string | null = null;
    if (undeclared.length > 0) {
      // 表面表没有它、或声明尚未取证 ⇒ 无法证明其输入与改动无关。此时**整轮转全量**：
      // 与"只让它自己跑"相比更保守，且把"该补声明"这件事顶到眼前（而不是静默兜住）。
      fallback = `有 ${String(undeclared.length)} 条门禁的输入未取证（${undeclared.join(', ')}）⇒ 不猜，转全量`;
    }
    // 该层选空 = 本次改动在该层没有判据可跑：**不能**当成"通过"（历史缺陷：`--only=<别的层>`
    // 曾零门禁 + 打印通过）。转该层全量，让"没得跑"变成"跑全"。
    if (fallback === null && hitInTier.length === 0 && inTierGates.length > 0) {
      fallback = `在 ${tier} 层没有任何门禁的判定输入被碰到（选中 0 条）⇒ 转该层全量`;
    }
    const selected = fallback === null ? hitInTier.map((g) => g.id) : inTierGates.map((g) => g.id);
    const reasons: Record<string, string> = {};
    for (const g of gates) {
      const t = touched.get(g.id);
      if (!tierWanted.has(g.tier)) reasons[g.id] = `不在本次层（--tier=${tier}）`;
      else if (fallback !== null) reasons[g.id] = '全量：分类被放弃（见兜底原因）';
      else if (!t?.skippable) reasons[g.id] = `不可跳过：${t?.why ?? '未取证'}`;
      else if (t.hit) {
        reasons[g.id] = `改动碰到其判定输入（${t.hits.join(' ') || '—'}）｜ ${t.why}`;
      } else reasons[g.id] = `本次改动不在其判定面内（已取证）｜ ${t.why}`;
    }
    return {
      selected,
      reasons,
      fallback,
      unmatched: undeclared,
      inTier: inTierGates.length,
      allGates: gates.length,
    };
  }

  /**
   * 取改动文件集（`staged` = HEAD→索引；`worktree` = HEAD→工作树，**含未跟踪新文件**）。
   *
   * 未跟踪文件必须计入：否则"新加一个文件"会被当成"没改动"——那是历史上最典型的漏判形态。
   * @param mode `staged` 或 `worktree`。
   * @returns 改动文件（仓库根相对）；git 不可用时返回 `null`（调用方 fail-closed）。
   */
  public changedFiles(mode: string): readonly string[] | null {
    const diffArgs = mode === 'staged' ? ['--cached'] : [];
    const diff = spawnSync(
      'git',
      ['diff', ...diffArgs, '--name-only', '--diff-filter=ACMRD', 'HEAD'],
      {
        cwd: this.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (diff.error !== undefined || diff.status !== 0) return null;
    const files = new Set(this.splitLines(String(diff.stdout)));
    if (mode === 'worktree') {
      const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: this.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (status.error !== undefined || status.status !== 0) return null;
      for (const line of String(status.stdout).split('\n')) {
        if (line.startsWith('?? ')) files.add(line.slice(3).trim());
      }
    }
    return [...files];
  }

  /**
   * 按行切分并去重（`git` 输出可能与平台换行混用）。
   * @param text 文本。
   * @returns 非空行。
   */
  private splitLines(text: string): readonly string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }

  /**
   * 执行一轮探针并归档。
   * @param options 命令行选项。
   * @returns 本轮归档结论。
   */
  public runProbes(options: BoostOptions): BoostProbeRun {
    const outRoot = this.outRoot(options);
    const outDir = join(outRoot, BoostCommand.stamp());
    mkdirSync(join(outDir, 'probes'), { recursive: true });
    mkdirSync(join(outDir, 'logs'), { recursive: true });
    const records: BoostProbeRecord[] = [];
    for (const name of options.probes) {
      const record = this.runOneProbe(name, outDir, options);
      records.push(record);
      const label = { ok: '通过', instrument: '仪器失败', measurement: '判据类结果' }[
        record.outcome
      ];
      process.stdout.write(
        `→ ${name} ... ${label} (exit=${record.status === null ? 'null' : String(record.status)} ` +
          `${(record.durationMs / 1000).toFixed(1)}s)\n`,
      );
      if (record.outcome !== 'ok') {
        process.stdout.write(`   日志：${record.stderrPath} ｜ ${record.stdoutPath}\n`);
      }
    }
    const ok = records.filter((r) => r.outcome === 'ok').length;
    const instrument = records.filter((r) => r.outcome === 'instrument').length;
    const measurement = records.filter((r) => r.outcome === 'measurement').length;
    const run: BoostProbeRun = {
      dir: this.rel(outDir),
      probes: records,
      ok,
      instrument,
      measurement,
      exitCode: instrument > 0 ? 1 : measurement > 0 ? 3 : 0,
    };
    writeFileSync(
      join(outDir, 'run.json'),
      `${JSON.stringify({ runner: 'omniharness boost probe', createdAt: new Date().toISOString(), gitCommit: this.gitCommit(), node: process.version, platform: `${process.platform}-${process.arch}`, withNetwork: options.network, ...run }, null, 2)}\n`,
      'utf8',
    );
    return run;
  }

  /**
   * 执行单个探针并如实归档（stdout/stderr 原样、不截断）。
   * @param name 探针名。
   * @param outDir 轮次目录。
   * @param options 选项（取超时与定向入参）。
   * @returns 记录。
   */
  private runOneProbe(name: string, outDir: string, options: BoostOptions): BoostProbeRecord {
    const reportAbs = join(outDir, 'probes', `${name}.json`);
    const stdoutAbs = join(outDir, 'logs', `${name}.out.txt`);
    const stderrAbs = join(outDir, 'logs', `${name}.err.txt`);
    const meta = PROBE_META[name];
    const argv = [
      `${PROBES_DIR}/${name}.mjs`,
      ...BoostProbes.argsFor(name, this.rel(reportAbs), options.args),
    ];
    const started = Date.now();
    const r = spawnSync(process.execPath, argv, {
      cwd: this.root,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      // stdin 显式 ignore：本机（Windows）子进程 stdin 走管道会 `EBUSY`（见 runGates.mjs 文件头实测）。
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const durationMs = Date.now() - started;
    writeFileSync(stdoutAbs, r.stdout ?? '', 'utf8');
    writeFileSync(stderrAbs, r.stderr ?? '', 'utf8');
    const timedOut =
      r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const status = timedOut ? null : (r.status ?? null);
    let outcome = BoostCommand.classifyExit(status, timedOut, meta);
    const record: BoostProbeRecord = {
      probe: name,
      status,
      outcome,
      timedOut,
      durationMs,
      reportPath: existsSync(reportAbs) ? this.rel(reportAbs) : null,
      stdoutPath: this.rel(stdoutAbs),
      stderrPath: this.rel(stderrAbs),
      scalars: {},
    };
    if (record.reportPath === null) {
      // 退出码 0 但没写出报告：`--json=` 被静默忽略的历史真的发生过 ⇒ 属仪器问题，不算通过。
      if (outcome === 'ok') outcome = 'instrument';
      return { ...record, outcome };
    }
    try {
      return { ...record, outcome, scalars: BoostProbes.scalarsOfFile(reportAbs) };
    } catch {
      return { ...record, outcome: outcome === 'ok' ? 'instrument' : outcome };
    }
  }

  /**
   * 读上一轮归档（缺省取最近一轮，排除本轮目录）。
   * @param outRoot 归档根。
   * @param currentDir 本轮目录（仓库根相对）。
   * @returns 上一轮记录或 null。
   */
  private previousRun(outRoot: string, currentDir: string): BoostProbeRun | null {
    let dirs: readonly string[];
    try {
      dirs = readdirSync(outRoot).sort();
    } catch {
      return null;
    }
    for (const d of [...dirs].reverse()) {
      const rel = this.rel(join(outRoot, d));
      if (rel === currentDir) continue;
      const run = BoostProbes.readRunFile(join(outRoot, d));
      if (run !== null) return run;
    }
    return null;
  }

  /**
   * 打印跨次比对。
   * @param current 本轮。
   * @param options 选项（取归档根）。
   * @returns 差异条目数。
   */
  public printDiff(current: BoostProbeRun, options: BoostOptions): number {
    const baseline = this.previousRun(this.outRoot(options), current.dir);
    if (baseline === null || baseline.dir === undefined) {
      process.stdout.write('\n== 跨次对比：没有更早的轮次可比（这是第一轮）==\n');
      return 0;
    }
    const entries = BoostCommand.diff(current, baseline);
    process.stdout.write(`\n== 跨次对比：${baseline.dir} → ${current.dir} ==\n`);
    for (const e of entries) {
      const where = e.key === null ? e.probe : `${e.probe}.${e.key}`;
      process.stdout.write(`  [${e.kind}] ${where} ${e.note}\n`);
    }
    if (entries.length === 0) process.stdout.write('  （标量读数完全一致）\n');
    return entries.length;
  }

  /**
   * 取 `HEAD` 提交号（脏工作树带 `-dirty`）。
   * @returns 提交号字符串；非 git 环境回 `unknown`。
   */
  public gitCommit(): string {
    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (head.error !== undefined || head.status !== 0) return 'unknown';
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const dirty = status.status === 0 && String(status.stdout).trim() !== '';
    return `${String(head.stdout).trim()}${dirty ? '-dirty' : ''}`;
  }

  /**
   * 处理 `boost gate`（挑选并可选执行门禁子集）。
   * @param options 选项。
   * @returns 进程退出码：0 = 子集通过；1 = 门禁失败；3 = 未执行（需人工全量核验）。
   */
  public runGate(options: BoostOptions): number {
    const gates = this.readGates();
    if (gates.length === 0) {
      process.stderr.write(
        '✗ 读不出门禁清单（scripts/runGates.mjs --list 失败或输出格式变了）。\n',
      );
      return 2;
    }
    const files = this.changedFiles(options.mode);
    if (files === null) {
      process.stderr.write('✗ 取不到改动集（不在 git 仓库内？）⇒ 不做增量判定。\n');
      return 2;
    }
    const decision = BoostCommand.decide(gates, files, options.tier);
    process.stdout.write(
      `omniharness boost gate ｜ 模式 ${options.mode} ｜ 改动 ${String(files.length)} 个文件 ｜ 层 ${options.tier}\n`,
    );
    if (decision.fallback !== null) process.stdout.write(`⚠️ 转全量：${decision.fallback}\n`);
    process.stdout.write(
      `判定：跑 ${String(decision.selected.length)}/${String(decision.inTier)} 条（该层 ${String(decision.inTier)} 条，全仓 ${String(decision.allGates)} 条）\n`,
    );
    if (options.explain) {
      for (const g of gates)
        process.stdout.write(`  ${g.id.padEnd(16)} ${decision.reasons[g.id] ?? ''}\n`);
    }
    if (options.outDir !== undefined) {
      const target = join(this.outDirAbs(options.outDir, DEFAULT_OUT_DIR), 'gate-decision.json');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        `${JSON.stringify({ tool: 'omniharness boost gate', createdAt: new Date().toISOString(), mode: options.mode, tier: options.tier, changedFiles: files, selected: decision.selected, fallback: decision.fallback, reasons: decision.reasons }, null, 2)}\n`,
        'utf8',
      );
    }
    if (!options.run) {
      process.stdout.write(
        '\n（未执行：默认只报告"该跑什么"。确认无误后加 --boost-run；退出码 3 = 需人工/全量核验。）\n',
      );
      return 3;
    }
    const argv = [GATES_SCRIPT, `--tier=${options.tier}`, `--only=${decision.selected.join(',')}`];
    process.stdout.write(`\n执行：node ${argv.join(' ')}\n\n`);
    const r = spawnSync(process.execPath, argv, { cwd: this.root, stdio: 'inherit' });
    if ((r.status ?? 1) !== 0) {
      process.stderr.write(
        `\n✗ 子集门禁未通过（退出码 ${String(r.status)}）——只说明这 ${String(decision.selected.length)} 条里至少一条红了。\n`,
      );
      return 1;
    }
    process.stdout.write(
      `\n✓ 子集门禁通过（跑了 ${String(decision.selected.length)}/${String(decision.inTier)} 条，层 ${options.tier}）` +
        `——**不是**"全部门禁通过"：剩余 ${String(decision.inTier - decision.selected.length)} 条的判据本次未执行。\n`,
    );
    return 0;
  }

  /**
   * 处理 `boost probe`（列出 / 跑一轮 / 比对）。
   * @param options 选项。
   * @returns 进程退出码：0 = 全通过；1 = 仪器失败；3 = 存在判据类结论。
   */
  public runProbe(options: BoostOptions): number {
    const all = BoostCommand.discoverProbes(this.root);
    if (all.length === 0) {
      process.stderr.write(`✗ 未发现任何探针（${PROBES_DIR}/ 不存在或没有 .mjs）。\n`);
      return 2;
    }
    const selected =
      options.probes.length > 0
        ? all.filter((n) => options.probes.includes(n))
        : BoostCommand.defaultSelection(all, options.network);
    const unknown = options.probes.filter((n) => !all.includes(n));
    if (unknown.length > 0) {
      process.stderr.write(`✗ 未知探针：${unknown.join(', ')}（用 --boost-list 看全部）\n`);
      return 2;
    }
    if (options.list) {
      process.stdout.write(`发现 ${String(all.length)} 个探针（${PROBES_DIR}/）：\n`);
      for (const name of all) {
        const meta = PROBE_META[name];
        const net = meta?.network === true ? '需网络' : '离线';
        const cost = meta?.cost ?? '未登记';
        const inDefault = BoostCommand.defaultSelection(all, options.network).includes(name);
        process.stdout.write(
          `  ${name.padEnd(26)} ${net.padEnd(5)} 成本 ${cost.padEnd(16)}${inDefault ? '' : ' [默认跑集不含]'}\n`,
        );
      }
      return 0;
    }
    if (selected.length === 0) {
      process.stderr.write('✗ 选中的探针为空（未登记的探针必须用 --boost-probe 显式点名）。\n');
      return 2;
    }
    if (options.args.length > 0 && selected.length !== 1) {
      process.stderr.write(
        `✗ --boost-arg 只允许在恰好选中 1 个探针时使用（当前选中 ${String(selected.length)} 个）。\n`,
      );
      return 2;
    }
    process.stdout.write(
      `omniharness boost probe ｜ 本轮 ${String(selected.length)} 个探针 ｜ 归档 ${this.rel(this.outRoot(options))}/\n`,
    );
    const run = this.runProbes({ ...options, probes: selected });
    process.stdout.write(
      `\n本轮小结：通过 ${String(run.ok)} ｜ 仪器失败 ${String(run.instrument)} ｜ 判据类结果 ${String(run.measurement)}` +
        '（判据类结果 = 探针明确报告"判据无区分力/纪律违规"，**是结论不是故障**）\n',
    );
    if (options.diff) this.printDiff(run, options);
    if (run.instrument > 0) {
      process.stderr.write(
        `\n✗ ${String(run.instrument)} 个探针属**仪器失败**（缺前置/超时/用法错）——这轮读数不能用，先修仪器。\n`,
      );
    }
    return run.exitCode;
  }

  /**
   * 处理 `boost audit-surface`（静态取证：声明的输入表面是否还配得上当前实现）。
   *
   * 它补的是 `boostGateSurface.ts` 的死穴：声明一旦过期，上层会**放心地跳过一条其实需要的门禁**
   * （假阴性）。故只要入口脚本内容变了，对应声明一律按"过期"报出，而不是"大概没事"。
   * @param options 选项（取 `outDir` 决定快照落点）。
   * @returns 进程退出码：3 = 需重新取证；0 = 无问题；2 = 读不出门禁清单。
   */
  public runSurfaceAudit(options: BoostOptions): number {
    const auditor = new BoostSurfaceAudit(this.root);
    // 落点解析收成一处：`--boost-dir` 是**绝对路径**时必须原样用（2026-10-11 由新增的 CLI 判据抓到：
    // 旧实现把它拼成 `D:\repo\C:\Users\…` ⇒ ENOENT）。
    const snapshotRel =
      options.outDir === undefined
        ? join(this.root, SURFACE_SNAPSHOT_REL)
        : join(this.outDirAbs(options.outDir, DEFAULT_OUT_DIR), 'gate-surface.json');
    // `--boost-run` 在这里的语义 = **确认已重新取证**（把当前脚本哈希记为基线）。
    // 默认不写快照：否则一次临时改动会把基线毒化，之后永远报"过期"（症状与"工具坏了"一样）。
    const report = auditor.audit(snapshotRel, options.run);
    if (report.findings.length === 0) {
      process.stderr.write(
        '✗ 读不出门禁清单（scripts/runGates.mjs --list 失败或输出格式变了）。\n',
      );
      return 2;
    }
    process.stdout.write(
      `omniharness boost audit-surface ｜ 声明取证日 ${report.declaredAuditDate}` +
        ` ｜ ${report.hasBaseline ? '与上次审计比对' : '首次审计（无基线，按"新"处理）'}\n\n`,
    );
    for (const f of report.findings) {
      const mark = f.needsReaudit ? '需重新取证' : f.fingerprintable ? 'ok        ' : '不可指纹  ';
      process.stdout.write(
        `  ${mark} ${f.id.padEnd(16)} ${f.script ?? '(入口在 node_modules 或由参数决定)'}\n`,
      );
      if (f.needsReaudit || !f.fingerprintable || f.unmentioned.length > 0) {
        process.stdout.write(`             ↳ ${f.reason}\n`);
      }
    }
    const blind = report.findings.filter((f) => !f.fingerprintable).map((f) => f.id);
    if (blind.length > 0) {
      process.stdout.write(
        `\n  ⚠ 这些门禁的入口**不在 scripts/ 下**（多为 node_modules 里的工具，argv 非脚本路径）：\n` +
          `    ${blind.join(', ')}\n` +
          '    ⇒ 本工具对它们**没有视野**：它们配置面一变，声明不会被判过期。判读时按"未覆盖"看待。\n',
      );
    }
    if (report.zombie.length > 0) {
      process.stdout.write(
        `\n  ⚠ 声明表里有上游已不存在的门禁（僵尸条目）：${report.zombie.join(', ')}\n` +
          '    ⇒ 删掉它们，否则"表里有交代"会掩盖"上游把门禁改名/删掉"这件事。\n',
      );
    }
    process.stdout.write(
      `\n小结：${String(report.findings.length)} 条门禁 ｜ 需重新取证 ${String(report.needsReauditCount)} 条` +
        ` ｜ 快照 ${snapshotRel}${report.wroteSnapshot ? '（本次已更新）' : '（本次未更新：确认重新取证后加 --boost-run）'}\n`,
    );
    if (report.exitCode !== 0) {
      process.stdout.write(
        '\n（退出码 3 = **声明需要重新取证**，不是崩溃：请重做一次真跑取证，再更新\n' +
          '  boostGateSurface.ts 里对应条目的 `audited` 字段。本工具**不做**系统级文件访问追踪\n' +
          '  （win32 上不可构造），故它只保证"过期会被看见"，不保证"新出现的读取会被自动发现"。）\n',
      );
    }
    return report.exitCode;
  }

  /**
   * 命令入口。
   * @param options 选项（`action` 决定走 `probe` 还是 `gate`）。
   * @returns 进程退出码。
   */
  public run(options: BoostOptions): number {
    if (options.action === 'probe') return this.runProbe(options);
    if (options.action === 'gate') return this.runGate(options);
    if (options.action === 'audit-surface') return this.runSurfaceAudit(options);
    process.stderr.write(
      `✗ 未知的 boost 子动作 "${options.action}"；可用：probe（探针归档与比对）、` +
        'gate（按改动挑门禁子集）、audit-surface（输入表面声明的静态取证）。\n',
    );
    return 2;
  }
}

/** 供 `cliDataCmds` 复用的超时缺省值。 */
export const BOOST_PROBE_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;
