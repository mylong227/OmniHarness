/**
 * I-P3-1 利希滕贝格刻蚀记忆引擎（Lichtenberg Insight Etching）。
 *
 * 顿悟事件 → 在记忆介质上刻出分形分支决策树；后续同类 query 沿共振最强的刻痕低阻导通
 * （返回分支路径标签序列）。复用燧-3 频率域共振（eigenSpectrum / resonance，bins=257）做
 * 刻痕寻址与导通匹配。无共振则回落正常检索（conduct 返回 []）。
 */

import type {
  InsightEtchingPort,
  EtchEvent,
  EtchTrace,
  EtchNode,
  EtchConduction,
  EtchBranch,
} from '../../ports/memory/insightEtching.js';
import { EigenSpectrum, type Spectrum } from '../../util/eigenspectrum.js';

export interface InsightEtchingOptions {
  /** 共振阈值（conduct 命中下限，默认 0.4）。 */
  readonly resonanceThreshold?: number | undefined;
  /** 频谱 bin 数（默认 257，质数防谐波别名）。 */
  readonly bins?: number | undefined;
}

interface StoredTrace {
  readonly trace: EtchTrace;
  readonly spectrum: Spectrum;
}

export class InsightEtchingEngine implements InsightEtchingPort {
  /**
   * 保留的刻痕上限（超出即按插入序淘汰最旧一条）。
   *
   * 依据：刻痕是「顿悟事件」的共振寻址索引，属于召回增强而非事实存储；每条目一个 257 维
   * 频谱，无上限等同于把长跑会话的内存交给调用频率决定。1024 条在实践中远超命中所需。
   */
  public static readonly MAX_TRACES = 1024;

  /** 引擎标识名（记忆检索引擎注册键，用于诊断与装配区分）。 */
  public readonly name = 'insight-etching';
  /** 共振导通命中下限（低于此刻痕不导通）。 */
  private readonly threshold: number;
  /** 频谱 bin 数（本征谱维度）。 */
  private readonly bins: number;
  /** 刻痕存储：trace id → 轨迹与其寻址频谱（进程内存态）。 */
  private readonly store = new Map<string, StoredTrace>();

  /**
   * @param opts 引擎选项（共振阈值与频谱 bin 数，全有默认）。
   */
  public constructor(opts: InsightEtchingOptions = {}) {
    this.threshold = opts.resonanceThreshold ?? 0.4;
    this.bins = opts.bins ?? 257;
  }

  /**
   * 刻蚀一次顿悟事件：在内存 Map 中建立分形分支决策树，并以主标签+分支标签联合频谱
   * 注册共振寻址。已存在同 ID 抛错（fail-closed）。
   *
   * @param event 待刻蚀的顿悟事件（id 与 label 必填）
   * @returns 刻好的刻痕轨迹（含根节点与创建时间）
   */
  public etch(event: EtchEvent): EtchTrace {
    if (!event.id || !event.label) {
      throw new Error('刻蚀失败：事件 ID 与标签均不可为空（fail-closed）');
    }
    if (this.store.has(event.id)) {
      throw new Error(`刻蚀失败：trace ${event.id} 已存在`);
    }
    const root: EtchNode = {
      id: event.id,
      label: event.label,
      children: (event.branches ?? []).map((b, i) =>
        InsightEtchingEngine.buildNode(event.id, i, b),
      ),
    };
    const trace: EtchTrace = {
      id: event.id,
      root,
      createdAt: new Date().toISOString(),
    };
    // 频谱以主标签 + 所有分支标签联合编码，使导通匹配覆盖整棵刻痕语义。
    const corpus = [
      event.label,
      ...InsightEtchingEngine.flattenLabelsFromBranches(event.branches ?? []),
    ].join(' ');
    this.store.set(event.id, { trace, spectrum: EigenSpectrum.eigenSpectrum(corpus, this.bins) });
    // 有界保留（2026-09-26 审计 S30）：`store` 原本无上限、重复 id 又抛错 ⇒ 只能单调增长，
    // 每条刻痕还带一个 257 维浮点频谱。Map 保持插入序，故按序淘汰最旧一条即可（FIFO）。
    while (this.store.size > InsightEtchingEngine.MAX_TRACES) {
      const oldest = this.store.keys().next();
      if (oldest.done === true) break;
      this.store.delete(oldest.value);
    }
    return trace;
  }

  /**
   * 对查询做频率域共振导通：返回按共振强度降序、命中阈值以上的刻痕路径序列。
   * 无刻痕或全未命中时返回空数组（回落正常检索）。
   *
   * @param query 查询文本
   * @param k 返回 Top-k（默认 1，至少 1）
   * @returns 命中刻痕的导通序列（按共振强度降序）
   */
  public conduct(query: string, k = 1): readonly EtchConduction[] {
    if (this.store.size === 0) return [];
    const q = EigenSpectrum.eigenSpectrum(query, this.bins);
    const scored: EtchConduction[] = [];
    for (const { trace, spectrum } of this.store.values()) {
      const r = EigenSpectrum.resonance(q, spectrum);
      if (r >= this.threshold) {
        scored.push({
          traceId: trace.id,
          resonance: r,
          path: InsightEtchingEngine.flattenLabels(trace.root.children),
        });
      }
    }
    scored.sort((a, b) => b.resonance - a.resonance);
    return scored.slice(0, Math.max(1, k));
  }

  /** 已刻蚀的刻痕轨迹数。 */
  public get traces(): number {
    return this.store.size;
  }

  /**
   * 构造分形分支节点（递归）。
   * @param prefix 父节点 id 前缀
   * @param idx 当前分支下标
   * @param branch 分支定义
   * @returns 构造出的分形节点
   */
  private static buildNode(prefix: string, idx: number, branch: EtchBranch): EtchNode {
    const id = `${prefix}:${idx}`;
    const children = (branch.subBranches ?? []).map((s, i) =>
      InsightEtchingEngine.buildNode(id, i, s),
    );
    return { id, label: branch.label, children };
  }

  /**
   * 节点树展平为标签序列（递归）。
   * @param nodes 待展平的节点树
   * @returns 标签序列（深度优先）
   */
  private static flattenLabels(nodes: readonly EtchNode[]): string[] {
    const out: string[] = [];
    for (const n of nodes) {
      out.push(n.label);
      out.push(...InsightEtchingEngine.flattenLabels(n.children));
    }
    return out;
  }

  /**
   * 分支树展平为标签序列（递归）。
   * @param branches 待展平的分支树
   * @returns 标签序列（深度优先）
   */
  private static flattenLabelsFromBranches(branches: readonly EtchBranch[]): string[] {
    const out: string[] = [];
    for (const b of branches) {
      out.push(b.label);
      if (b.subBranches) out.push(...InsightEtchingEngine.flattenLabelsFromBranches(b.subBranches));
    }
    return out;
  }
}
