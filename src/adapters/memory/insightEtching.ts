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
} from '../../ports/insightEtching.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';

export interface InsightEtchingOptions {
  /** 共振阈值（conduct 命中下限，默认 0.4）。 */
  readonly resonanceThreshold?: number;
  /** 频谱 bin 数（默认 257，质数防谐波别名）。 */
  readonly bins?: number;
}

interface StoredTrace {
  readonly trace: EtchTrace;
  readonly spectrum: Spectrum;
}

function buildNode(prefix: string, idx: number, branch: EtchBranch): EtchNode {
  const id = `${prefix}:${idx}`;
  const children = (branch.subBranches ?? []).map((s, i) => buildNode(id, i, s));
  return { id, label: branch.label, children };
}

export class InsightEtchingEngine implements InsightEtchingPort {
  readonly name = 'insight-etching';
  private readonly threshold: number;
  private readonly bins: number;
  private readonly store = new Map<string, StoredTrace>();

  constructor(opts: InsightEtchingOptions = {}) {
    this.threshold = opts.resonanceThreshold ?? 0.4;
    this.bins = opts.bins ?? 257;
  }

  etch(event: EtchEvent): EtchTrace {
    if (!event.id || !event.label) {
      throw new Error('刻蚀失败：事件 ID 与标签均不可为空（fail-closed）');
    }
    if (this.store.has(event.id)) {
      throw new Error(`刻蚀失败：trace ${event.id} 已存在`);
    }
    const root: EtchNode = {
      id: event.id,
      label: event.label,
      children: (event.branches ?? []).map((b, i) => buildNode(event.id, i, b)),
    };
    const trace: EtchTrace = {
      id: event.id,
      root,
      createdAt: new Date().toISOString(),
    };
    // 频谱以主标签 + 所有分支标签联合编码，使导通匹配覆盖整棵刻痕语义。
    const corpus = [event.label, ...flattenLabelsFromBranches(event.branches ?? [])].join(' ');
    this.store.set(event.id, { trace, spectrum: eigenSpectrum(corpus, this.bins) });
    return trace;
  }

  conduct(query: string, k = 1): readonly EtchConduction[] {
    if (this.store.size === 0) return [];
    const q = eigenSpectrum(query, this.bins);
    const scored: EtchConduction[] = [];
    for (const { trace, spectrum } of this.store.values()) {
      const r = resonance(q, spectrum);
      if (r >= this.threshold) {
        scored.push({ traceId: trace.id, resonance: r, path: flattenLabels(trace.root.children) });
      }
    }
    scored.sort((a, b) => b.resonance - a.resonance);
    return scored.slice(0, Math.max(1, k));
  }

  get traces(): number {
    return this.store.size;
  }
}

function flattenLabels(nodes: readonly EtchNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.label);
    out.push(...flattenLabels(n.children));
  }
  return out;
}

function flattenLabelsFromBranches(branches: readonly EtchBranch[]): string[] {
  const out: string[] = [];
  for (const b of branches) {
    out.push(b.label);
    if (b.subBranches) out.push(...flattenLabelsFromBranches(b.subBranches));
  }
  return out;
}
