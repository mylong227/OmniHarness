/**
 * 探针侧**纯逻辑**：发现 / 默认跑集 / 退出码语义 / 标量提取 / 跨次比对。
 *
 * ## 为什么单独成文件
 *
 * 两件事都不属于"命令编排"：① 退出码语义与默认跑集是**口径**（决定读数能不能信、哪些探针默认跑）；
 * ② 标量提取与比对是**纯函数**（无盘无网，因而可以被机械验证）。把它们留在 `boostCommand.ts` 里
 * 会让那个文件同时承担"编排 + 口径 + 算法"，且逼近 `scripts/check.mjs` 的单文件行数上限
 * （810 行）——本仓的惯例是**抽出去**，不是放宽阈值。
 *
 * ## 口径（三条，都有代价换来的理由）
 *
 * - **退出码是数据不是布尔**：`tools/probes/README.md` 定死 `2` = 前置/用法错（仪器坏）、
 *   `3` = 判据无区分力（**结论**）、`4` = 纪律违规（结论）。把 3/4 当失败会让真实发现被当成故障修。
 * - **默认跑集只认"登记过"**：新落进 `tools/probes/` 但本表未登记的探针**不会**因为"存在"就进入
 *   每轮跑集——否则一次新增就能把一轮成本抬高几分钟，而使用者毫无察觉。
 * - **比对只比标量叶子**：数组（`misses` 列表、候选池）与字符串（含路径/时间戳）逐次都会变，
 *   混进来会把真信号淹掉；且「数字变了」与「口径变了」在 `diff()` 里是**不同 kind**，不许混报。
 *
 * ## 诚实边界
 *
 * - 元数据表里的成本是**量级提示**，不是承诺：语料变大、首跑拉模型权重都会让它变长。
 * - `gitCommit` 只由调用方归档，本文件不解释它——它**不是**"两次读数同语料"的证明。
 * - 数组内元素**不参与**比对：探针把结论放在数组里时（如逐查询明细），本模块看不到它们的逐项变化。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 探针目录（相对仓库根）。 */
export const PROBES_DIR = 'tools/probes';

/** 缺省视为"判据类结论"的退出码（与 `tools/probes/README.md` 一致）。 */
export const DEFAULT_MEASUREMENT_EXIT_CODES: readonly number[] = [3, 4];

/** 数值比对的浮点容差：末位差不算"变化"。 */
export const SCALAR_EPSILON = 1e-12;

/** 探针元数据（成本 / 是否需网络 / 默认入参 / 哪些退出码算结论）。 */
export interface BoostProbeMeta {
  /** 人类可读成本量级（仅用于展示，不参与判定）。 */
  readonly cost: string;
  /** 是否起网络（默认跑集不含，需 `--boost-network` 纳入）。 */
  readonly network?: boolean;
  /** 默认入参（位置参数在前）。 */
  readonly args?: readonly string[];
  /** 该探针把哪些退出码当作"判据类结论"。 */
  readonly measurementExitCodes?: readonly number[];
}

/**
 * 探针元数据表（**补充**文件名发现，不是清单的第二份真相）。
 *
 * `rerankDiscriminatorAb` 显式给位置参数 `14`：不给时它自行取默认，读数口径就与
 * `tools/probes/README.md` 记录的 `K=14` 不同——**同名的两个数字不可比**。
 */
export const PROBE_META: Readonly<Record<string, BoostProbeMeta>> = {
  recallHitrate: { cost: '~30s' },
  toolExposureBudget: { cost: '~20s' },
  rerankDiscriminatorAb: { cost: '~2min', args: ['14'] },
  memoryLiftProbe: { cost: '~1min' },
  evolutionLiftProbe: { cost: '~2min', measurementExitCodes: [3, 4] },
  bm25TuneSweep: { cost: '~2min' },
  semanticHybridRecall: { cost: '~4min（首跑更久）', network: true },
  semanticCrossRepo: { cost: '~3min', network: true, measurementExitCodes: [3] },
};

/** 单个探针的执行记录。 */
export interface BoostProbeRecord {
  /** 探针名。 */
  readonly probe: string;
  /** 子进程退出码；超时/被信号杀死为 `null`。 */
  readonly status: number | null;
  /** 可信度分类。 */
  readonly outcome: 'ok' | 'instrument' | 'measurement';
  /** 是否超时。 */
  readonly timedOut: boolean;
  /** 耗时（毫秒）。 */
  readonly durationMs: number;
  /** 报告落点（仓库根相对）；未生成 `null`。 */
  readonly reportPath: string | null;
  /** stdout 落点（仓库根相对）。 */
  readonly stdoutPath: string;
  /** stderr 落点（仓库根相对）。 */
  readonly stderrPath: string;
  /** 报告里的标量叶子（供跨次比对）。 */
  readonly scalars: Readonly<Record<string, number | boolean>>;
}

/** 一轮探针归档。 */
export interface BoostProbeRun {
  /** 归档目录（仓库根相对）。 */
  readonly dir: string;
  /** 记录。 */
  readonly probes: readonly BoostProbeRecord[];
  /** 通过数。 */
  readonly ok: number;
  /** 仪器失败数。 */
  readonly instrument: number;
  /** 判据类结论数。 */
  readonly measurement: number;
  /** 建议退出码：仪器坏 ⇒ 1；仅结论类 ⇒ 3；全通过 ⇒ 0。 */
  readonly exitCode: number;
}

/** 跨次比对条目。 */
export interface BoostDiffEntry {
  /** `add` 新增键 / `remove` 消失键 / `change` 数值变化 / `class` 可信度变化 / `probe` 探针增删。 */
  readonly kind: 'add' | 'remove' | 'change' | 'class' | 'probe';
  /** 归属探针。 */
  readonly probe: string;
  /** 标量键路径（探针增删为 `null`）。 */
  readonly key: string | null;
  /** 人类可读说明（区分"数字变了"与"口径变了"）。 */
  readonly note: string;
}

/** 探针侧的纯逻辑。 */
export class BoostProbes {
  /**
   * 发现探针（`tools/probes/*.mjs`，`_` 前缀为共享模块、不是探针）。
   * @param root 仓库根绝对路径。
   * @returns 按名排序的探针名；目录不可读时返回空数组（由调用方 fail-closed）。
   */
  public static discover(root: string): readonly string[] {
    let names: readonly string[];
    try {
      names = readdirSync(join(root, PROBES_DIR));
    } catch {
      // 目录不可读 ⇒ 空数组；"读不出探针"必须由调用方响亮失败，而不是在这里编一个默认值。
      return [];
    }
    return names
      .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
      .map((f) => f.slice(0, -'.mjs'.length))
      .sort();
  }

  /**
   * 默认跑集：**登记过**且不标 `network` 的探针（详见文件头口径）。
   * @param all 全部探针名。
   * @param network 是否纳入需网络的探针。
   * @returns 默认跑集（保持入参顺序）。
   */
  public static defaultSelection(all: readonly string[], network: boolean): readonly string[] {
    return all.filter((name) => {
      const meta = PROBE_META[name];
      if (meta === undefined) return false;
      return meta.network !== true || network;
    });
  }

  /**
   * 把子进程退出码翻译成**可信度分类**。
   * @param status 退出码；`null` = 超时或被信号杀死。
   * @param timedOut 是否超时。
   * @param meta 探针元数据（决定哪些退出码算"结论"）。
   * @returns 分类。
   */
  public static classifyExit(
    status: number | null,
    timedOut: boolean,
    meta?: { readonly measurementExitCodes?: readonly number[] },
  ): 'ok' | 'instrument' | 'measurement' {
    if (timedOut || status === null) return 'instrument';
    if (status === 0) return 'ok';
    const codes = meta?.measurementExitCodes ?? DEFAULT_MEASUREMENT_EXIT_CODES;
    return codes.includes(status) ? 'measurement' : 'instrument';
  }

  /**
   * 组装某探针的子进程参数（位置参数在前，报告路径用仓库根相对形式）。
   * @param name 探针名。
   * @param reportRelPath 报告落点（仓库根相对）。
   * @param extraArgs 覆盖默认入参（空数组 ⇒ 用元数据里的默认入参）。
   * @returns 参数数组。
   */
  public static argsFor(
    name: string,
    reportRelPath: string,
    extraArgs: readonly string[],
  ): readonly string[] {
    const base = extraArgs.length > 0 ? extraArgs : (PROBE_META[name]?.args ?? []);
    return [...base, `--json=${reportRelPath}`];
  }

  /**
   * 收集报告里的标量叶子（数字/布尔）；数组与字符串**跳过**。
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
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'number' || typeof value === 'boolean') {
        out[path] = value;
        continue;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        BoostProbes.collectScalars(value, path, out);
      }
    }
  }

  /**
   * 从报告文件读出标量（文件不存在/解析失败 ⇒ 空对象，由调用方定性为仪器问题）。
   * @param reportAbs 报告绝对路径。
   * @returns 标量叶子。
   */
  public static scalarsOfFile(reportAbs: string): Readonly<Record<string, number | boolean>> {
    const out: Record<string, number | boolean> = {};
    const parsed: unknown = JSON.parse(readFileSync(reportAbs, 'utf8'));
    BoostProbes.collectScalars(parsed, '', out);
    return out;
  }

  /**
   * 比对两轮读数：**数字变了**（`change`）与**口径变了**（`add`/`remove`）分开报。
   * @param current 本轮。
   * @param baseline 基线。
   * @returns 差异条目（确定性顺序：先探针增删/分类，再按探针名与键名排序）。
   */
  public static diff(current: BoostProbeRun, baseline: BoostProbeRun): readonly BoostDiffEntry[] {
    const entries: BoostDiffEntry[] = [];
    const before = new Map(baseline.probes.map((p) => [p.probe, p]));
    const afterNames = new Set(current.probes.map((p) => p.probe));
    for (const now of current.probes) {
      const was = before.get(now.probe);
      if (was === undefined) {
        entries.push({
          kind: 'probe',
          probe: now.probe,
          key: null,
          note: '基线里没有 ⇒ 无数值可比',
        });
        continue;
      }
      if (was.outcome !== now.outcome) {
        entries.push({
          kind: 'class',
          probe: now.probe,
          key: null,
          note: `可信度分类变化 ${was.outcome} → ${now.outcome} ⇒ 读数前提变了，先看日志`,
        });
      }
      entries.push(...BoostProbes.diffScalars(now, was));
    }
    for (const was of baseline.probes) {
      if (afterNames.has(was.probe)) continue;
      entries.push({
        kind: 'probe',
        probe: was.probe,
        key: null,
        note: '本轮未跑 ⇒ 不是"读数没变"',
      });
    }
    return entries;
  }

  /**
   * 比对单个探针的标量键集。
   * @param now 本轮记录。
   * @param was 基线记录。
   * @returns 差异条目。
   */
  private static diffScalars(
    now: BoostProbeRecord,
    was: BoostProbeRecord,
  ): readonly BoostDiffEntry[] {
    const entries: BoostDiffEntry[] = [];
    const keys = [...new Set([...Object.keys(was.scalars), ...Object.keys(now.scalars)])].sort();
    for (const key of keys) {
      const a = was.scalars[key];
      const b = now.scalars[key];
      if (a === undefined) {
        entries.push({
          kind: 'add',
          probe: now.probe,
          key,
          note: '本轮新增键 ⇒ **口径变了**，别当成增益',
        });
        continue;
      }
      if (b === undefined) {
        entries.push({
          kind: 'remove',
          probe: now.probe,
          key,
          note: '本轮键消失 ⇒ **口径变了**，别当成退化',
        });
        continue;
      }
      if (!BoostProbes.changed(a, b)) continue;
      const isNum = typeof a === 'number' && typeof b === 'number';
      entries.push({
        kind: 'change',
        probe: now.probe,
        key,
        note: isNum ? `Δ=${(b - a).toFixed(6)}` : '布尔翻转',
      });
    }
    return entries;
  }

  /**
   * 两个标量是否算"变化"（数值走容差，布尔走严格）。
   * @param a 旧值。
   * @param b 新值。
   * @returns 是否变化。
   */
  public static changed(a: number | boolean, b: number | boolean): boolean {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a) > SCALAR_EPSILON;
    return a !== b;
  }

  /**
   * 读一轮的 `run.json`（读不出返回 `null`；**不编造**）。
   * @param dir 轮次目录（绝对路径）。
   * @returns 归档或 null。
   */
  public static readRunFile(dir: string): BoostProbeRun | null {
    try {
      return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as BoostProbeRun;
    } catch {
      return null;
    }
  }

  /**
   * 本地时间戳目录名（字典序 = 时间序）。
   * @param now 时间点（缺省当前）。
   * @returns `YYYYMMDD-HHmmss`。
   */
  public static stamp(now: Date = new Date()): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    return (
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    );
  }
}
