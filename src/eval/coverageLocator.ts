/**
 * 基于覆盖率的缺陷定位（SBFL，Spectrum-Based Fault Localization）。
 *
 * 用途：检索召回缺口（对抗口径剩余 ~24.2pp）的根因之一是「模型没把要改的源文件排进上下文」。
 * 谱故障定位用测试执行时的**语句覆盖谱**给文件/语句打「可疑度」，把官方 FAIL_TO_PASS 测试真正
 * 跑到的源文件**强制前置**进检索结果，专攻这一召回缺口（对齐 AutoCodeRover / Agentless 的
 * 「先定位后修复」）。
 *
 * 本模块只含**纯函数**（Ochiai 可疑度 + coverage.json 解析 + 排序），零 IO、零依赖、可单测；
 * 真正跑 `pytest --cov` 的 shell 调用放在预测脚本（best-effort，需 git+uv+网络），与本模块解耦。
 *
 * @maturity L1 — 判据：Ochiai 可疑度与 coverage.json 解析已落单测；端到端 SBFL 提升需在有
 *   网络/uv 的环境跑真实实例验证（本沙箱无网络，仅验证纯逻辑）。
 * @maturityEvidence tests/unit/coverageLocator.test.ts
 */

/** 单文件可疑度得分（score 越大越可疑）。 */
export interface FileScore {
  /** 仓库内相对路径。 */
  readonly file: string;
  /** 可疑度（此处用覆盖语句数近似；配合 {@link ochiai} 可作加权）。 */
  readonly score: number;
}

/**
 * Ochiai 可疑度系数（SBFL 经典公式）。
 *
 * `susp = N_CF / sqrt((N_CF + N_UF) * (N_CF + N_CS))`
 * - `N_CF`：覆盖该语句的**失败**测试数；
 * - `N_UF`：未覆盖该语句的失败测试数；
 * - `N_CS`：覆盖该语句的**通过**测试数。
 * 分母 ≤ 0（无失败测试覆盖）⇒ 返回 `N_CF>0 ? 1 : 0`（无信号）。
 * @param nCf 覆盖该语句的失败测试数。
 * @param nUf 未覆盖该语句的失败测试数。
 * @param nCs 覆盖该语句的通过测试数。
 * @returns 0..1 的可疑度。
 */
export function ochiai(nCf: number, nUf: number, nCs: number): number {
  const denom = Math.sqrt((nCf + nUf) * (nCf + nCs));
  if (denom <= 0) return nCf > 0 ? 1 : 0;
  return nCf / denom;
}

/**
 * `coverage.json`（pytest-cov `--cov-report=json`）的最小结构。
 * 只取我们关心的字段，其余忽略，避免对报告格式过度耦合。
 */
interface CoverageJson {
  /** 文件相对路径 → 覆盖明细。 */
  readonly files?: Readonly<Record<string, CoverageFileEntry>>;
}

/** 单文件覆盖明细。 */
interface CoverageFileEntry {
  /** 已执行行号（缺省回退 summary.covered_lines）。 */
  readonly executed_lines?: readonly number[];
  /** 汇总（covered_lines / num_statements 等）。 */
  readonly summary?: { readonly covered_lines?: number };
}

/**
 * 从 `coverage.json` 文本解析出「文件 → 覆盖语句数」，按覆盖语句数降序排列。
 *
 * 覆盖语句数越多 ⇒ 该文件被 FAIL_TO_PASS 测试执行得越深 ⇒ 越可能是缺陷所在（best-effort 近似；
 * 更严谨的可疑度应结合失败/通过测试覆盖谱，由 {@link ochiai} 加权，留给调用方组合）。
 * @param jsonText `coverage.json` 的原始文本。
 * @returns 按 score 降序的文件可疑度列表（空输入/解析失败返回空数组，fail-closed）。
 */
export function rankFilesFromCoverageJson(jsonText: string): readonly FileScore[] {
  let data: CoverageJson;
  try {
    data = JSON.parse(jsonText) as CoverageJson;
  } catch {
    return [];
  }
  const out: FileScore[] = [];
  for (const [file, info] of Object.entries(data.files ?? {})) {
    const n = info.summary?.covered_lines ?? info.executed_lines?.length ?? 0;
    if (n > 0) out.push({ file, score: n });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 把 SBFL 定位出的可疑文件**前置**进现有检索命中列表（去重，保持原序）。
 *
 * 这是把「覆盖率定位」接到检索层的接缝：检索召回漏掉的目标文件，由 SBFL 兜底补回，
 * 直接攻击对抗口径的召回缺口。仅当 SBFL 产出了额外文件时才改变顺序（零行为变更于 SBFL 关闭时）。
 * @param boosted SBFL 排序后的可疑文件（降序）。
 * @param retrieved 检索命中的文件（按检索次序）。
 * @param limit 最多前置多少 SBFL 文件（避免把整库塞进上下文）。
 * @returns 合并后的文件列表（boosted 在前，retrieved 去重在后）。
 */
export function prependBoosted(
  boosted: readonly FileScore[],
  retrieved: readonly string[],
  limit: number,
): readonly string[] {
  const seen = new Set<string>(retrieved);
  const head: string[] = [];
  for (const b of boosted.slice(0, limit)) {
    if (!seen.has(b.file)) {
      head.push(b.file);
      seen.add(b.file);
    }
  }
  return [...head, ...retrieved];
}
