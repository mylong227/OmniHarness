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
import { dirname, join, relative } from 'node:path';
import {
  BoostProbes,
  PROBES_DIR,
  PROBE_META,
  type BoostDiffEntry,
  type BoostProbeRecord,
  type BoostProbeRun,
} from './boostProbes.js';

/** 归档根（仓库内、运行时产物；与 `.omniharness/` 同类，不入库）。 */
const DEFAULT_OUT_DIR = join('.omniharness', 'boost');

/** 门禁唯一实现的入口（相对仓库根）。 */
const GATES_SCRIPT = 'scripts/runGates.mjs';

/** 单探针超时缺省值（30 分钟：够 `semanticHybridRecall` 首跑拉权重 + 千文件索引）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 1_800_000;

/**
 * 任何改动下都可能变红的门禁（**永不跳过**）。
 *
 * 逐个理由（不是"顺手加的"）：
 *  - `node-engine`：校验 `engines.node` 下限；改 `package.json` 会影响，而它本身极便宜；
 *  - `iron-law`：`scripts/check.mjs --strict` 扫全仓铁律，任何新文件都可能踩线；
 *  - `maturity`：L2/L3 声明须有测试证据（还会顺 `@maturityEvidence` 读 `tests/**`）；
 *  - `standard-delta`：**"禁止本次提交新增违规"**——跳过它等于对本次改动不做标准判定；
 *  - `arch`：`core↔adapters` 冻结白名单 + ports 纯度，任何新增 `.ts` 都可能新增违规。
 */
const ALWAYS_GATES: readonly string[] = [
  'node-engine',
  'iron-law',
  'maturity',
  'standard-delta',
  'arch',
];

/** 探针侧的元数据/纯逻辑/类型统一由 `boostProbes.ts` 提供（本文件只做编排）。 */
export type { BoostDiffEntry, BoostProbeRecord, BoostProbeRun };

/** 单条改动分类规则。 */
interface BoostRule {
  /** 路径正则（对**正斜杠**形式匹配）。 */
  readonly match: RegExp;
  /** 命中即转全量（该路径会让"子集保守性"本身失效）。 */
  readonly full?: boolean;
  /** 该路径**额外**需要的门禁（兜底集不必重复）。 */
  readonly gates?: readonly string[];
  /** 人类可读理由。 */
  readonly why: string;
}

/**
 * 改动分类规则表（**按顺序匹配，先命中者胜**）。
 *
 * `full=true` 的几类理由：改它们等于改**判据本身**（门禁脚本、探针语料、测试夹具、CI、
 * 依赖与配置面）。宁可不省，不可漏判。
 */
const RULES: readonly BoostRule[] = [
  { match: /^scripts\//, full: true, why: '门禁脚本/钩子包装本身，改它等于改判据' },
  { match: /^tools\/probes\//, full: true, why: '探针是判据的语料，改语料即改读数' },
  { match: /^tests\//, full: true, why: '测试夹具是成熟度门禁的证据来源' },
  { match: /^eval-data\//, full: true, why: '外部语料，门禁与探针都会读' },
  { match: /^crates\/|^native\/|^Cargo\.(toml|lock)$/, full: true, why: 'Rust 原生内核与绑定' },
  { match: /^\.github\//, full: true, why: 'CI 工作流自身' },
  {
    match: /^\.gitignore$|^\.gitattributes$/,
    full: true,
    why: '决定哪些文件进仓库，影响全部门禁的可见输入',
  },
  {
    match:
      /(^|\/)(package(-lock)?\.json|tsconfig(\..+)?\.json|eslint\.(typed\.)?config\.(mjs|d\.mts)|\.prettierrc\.json|\.prettierignore|dependency-allowlist\.json|omniharness\.json(\.example)?|\.gitleaks\.toml|config\.example\.yaml|\.nvmrc)$/,
    full: true,
    why: '配置/依赖/忽略面：会改变门禁的扫描面与判定域',
  },
  {
    match: /^src\/.*\.tsx?$/,
    gates: ['eslint', 'tsc', 'eslint-typed', 'top-level-fn', 'wiring'],
    why: '源码：ESLint + 类型层 + 顶层 function；可能改接线',
  },
  {
    match: /^web\/.*\.(ts|tsx)$/,
    gates: ['eslint', 'tsc', 'eslint-typed'],
    why: '前端源码：同源码但不受顶层 function 规则约束（UI 例外）',
  },
  { match: /\.(ts|tsx|mts|cts)$/, gates: ['eslint', 'tsc', 'eslint-typed'], why: '其它位置的 TS' },
  { match: /\.(md|mdx)$/, gates: ['doc-links'], why: '文档：只可能造成死链，进不了代码门禁的判据' },
  {
    match: /\.(mjs|cjs|js)$/,
    full: true,
    why: 'JS 脚本无类型/顶层 function 判据可依赖，保守转全量',
  },
  {
    match: /\.(json|ya?ml|toml|ini)$/,
    gates: ['secrets'],
    why: '数据/配置类：无代码判据，只剩密钥面',
  },
  {
    match: /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|woff2?|ttf|onnx|bin|node|wasm|tgz)$/,
    gates: ['secrets'],
    why: '二进制资源：只做密钥扫描',
  },
  { match: /\.(txt|css|html)$/, gates: ['secrets'], why: '文本资源（非文档）：仅密钥面' },
  {
    match: /(^|\/)(LICENSE|NOTICE|THIRD_PARTY_ASSETS\.md)$/,
    gates: ['doc-links'],
    why: '许可与第三方说明：文档类',
  },
];

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
    return relative(this.root, abs).replaceAll('\\', '/');
  }

  /**
   * 归档根绝对路径（`--boost-dir DIR` 可覆盖）。
   * @param options 命令行选项。
   * @returns 归档根绝对路径。
   */
  private outRoot(options: BoostOptions): string {
    return options.outDir === undefined
      ? join(this.root, DEFAULT_OUT_DIR)
      : join(this.root, options.outDir);
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
    const extra = new Set<string>();
    const unmatched: string[] = [];
    let fallback: string | null = null;
    for (const raw of files) {
      const f = raw.replaceAll('\\', '/');
      const rule = RULES.find((r) => r.match.test(f));
      if (rule === undefined) {
        unmatched.push(f);
        continue;
      }
      if (rule.full === true) {
        fallback ??= `${f} ⇒ ${rule.why}`;
        continue;
      }
      for (const id of rule.gates ?? []) extra.add(id);
    }
    if (unmatched.length > 0 && fallback === null) {
      fallback = `有 ${String(unmatched.length)} 个文件的类型未被规则表登记（例：${unmatched[0] ?? ''}）⇒ 不猜，转全量`;
    }
    // 双向核对：上游新增的门禁若本表不可达，**不猜**（否则新判据会被静默跳过）。
    const reachable = new Set(ALWAYS_GATES);
    for (const r of RULES) for (const id of r.gates ?? []) reachable.add(id);
    const unreachable = gates.filter((g) => !reachable.has(g.id)).map((g) => g.id);
    if (unreachable.length > 0) {
      fallback ??= `上游新增了规则表覆盖不到的门禁 ${unreachable.join(', ')} ⇒ 转全量`;
    }
    const tierWanted = new Set(tier === 'all' ? ['fast', 'typed'] : [tier]);
    const inTierGates = gates.filter((g) => tierWanted.has(g.tier));
    let full = fallback !== null;
    const pick = (): readonly string[] =>
      gates
        .filter(
          (g) => tierWanted.has(g.tier) && (full || ALWAYS_GATES.includes(g.id) || extra.has(g.id)),
        )
        .map((g) => g.id);
    let selected = pick();
    // 该层选空 = 本次改动在该层没有判据可跑：**不能**当成"通过"（历史缺陷：`--only=<别的层>`
    // 曾零门禁 + 打印通过）。转该层全量，让"没得跑"变成"跑全"。
    if (selected.length === 0 && inTierGates.length > 0) {
      fallback = `在 ${tier} 层选中 0 条（本次改动与该层判据无交集）⇒ 转该层全量`;
      full = true;
      selected = pick();
    }
    const reasons: Record<string, string> = {};
    for (const g of gates) {
      if (!tierWanted.has(g.tier)) reasons[g.id] = `不在本次层（--tier=${tier}）`;
      else if (full) reasons[g.id] = '全量：分类被放弃（见兜底原因）';
      else if (ALWAYS_GATES.includes(g.id))
        reasons[g.id] = '兜底集：任何改动都可能由"本次提交内容"触发';
      else if (extra.has(g.id)) reasons[g.id] = '被改动类型触发';
      else reasons[g.id] = '本次改动文件不在该门禁的判定面上（类型已登记，未触发兜底）';
    }
    return {
      selected,
      reasons,
      fallback,
      unmatched,
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
      const target = join(this.root, options.outDir, 'gate-decision.json');
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
   * 命令入口。
   * @param options 选项（`action` 决定走 `probe` 还是 `gate`）。
   * @returns 进程退出码。
   */
  public run(options: BoostOptions): number {
    if (options.action === 'probe') return this.runProbe(options);
    if (options.action === 'gate') return this.runGate(options);
    process.stderr.write(
      `✗ 未知的 boost 子动作 "${options.action}"；可用：probe（探针归档与比对）、gate（按改动挑门禁子集）。\n`,
    );
    return 2;
  }
}

/** 供 `cliDataCmds` 复用的超时缺省值。 */
export const BOOST_PROBE_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;
