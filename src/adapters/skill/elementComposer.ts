/**
 * I-P3-2 元素组合基元引擎（Periodic Table Primitives）。
 *
 * 有限基元集（元素周期表）→ 组合出多样能力。组合合法 = 相邻元素价互补(valence 相加为 0)，
 * 否则 fail-closed 拒绝（返回 undefined）。能力是组合代数产物，有限基元涌现无限组合。
 */

import type {
  ElementComposerPort,
  ElementDef,
  CompoundCapability,
} from '../../ports/elementComposer.js';

/** 默认元素周期表（有限基元集，valence 互补即合法组合）。 */
const DEFAULT_TABLE: readonly ElementDef[] = [
  { symbol: 'Na', group: 'alkali', valence: 1, tags: ['mutate', 'write'] },
  { symbol: 'Cl', group: 'halogen', valence: -1, tags: ['scope', 'guard'] },
  { symbol: 'K', group: 'alkali', valence: 1, tags: ['mutate', 'cache'] },
  { symbol: 'Br', group: 'halogen', valence: -1, tags: ['scope', 'verify'] },
  { symbol: 'Mg', group: 'alkaline', valence: 2, tags: ['batch', 'write'] },
  { symbol: 'O', group: 'chalcogen', valence: -2, tags: ['compress', 'read'] },
  { symbol: 'Ca', group: 'alkaline', valence: 2, tags: ['batch', 'guard'] },
  { symbol: 'S', group: 'chalcogen', valence: -2, tags: ['compress', 'emit'] },
  { symbol: 'Ar', group: 'noble', valence: 0, tags: ['neutral', 'passthrough'] },
  { symbol: 'He', group: 'noble', valence: 0, tags: ['neutral', 'isolate'] },
];

export class ElementComposer implements ElementComposerPort {
  readonly name = 'element-composer';
  private readonly table: Map<string, ElementDef>;

  constructor(table: readonly ElementDef[] = DEFAULT_TABLE) {
    this.table = new Map(table.map((e) => [e.symbol, e]));
  }

  elements(): readonly ElementDef[] {
    return [...this.table.values()];
  }

  compatible(a: string, b: string): boolean {
    const ea = this.table.get(a);
    const eb = this.table.get(b);
    if (ea === undefined || eb === undefined) {
      throw new Error(`组合失败：未知元素 ${ea === undefined ? a : b}（fail-closed）`);
    }
    return ea.valence + eb.valence === 0;
  }

  compose(symbols: readonly string[]): CompoundCapability | undefined {
    if (symbols.length < 2) return undefined; // 单元素不构成"组合"
    const defs: ElementDef[] = [];
    for (const s of symbols) {
      const d = this.table.get(s);
      if (d === undefined) throw new Error(`组合失败：未知元素 ${s}（fail-closed）`);
      defs.push(d);
    }
    // 全相邻对必须价互补，否则组合不合法。
    for (let i = 0; i < defs.length - 1; i++) {
      if (defs[i]!.valence + defs[i + 1]!.valence !== 0) return undefined;
    }
    const tags = [...new Set(defs.flatMap((d) => d.tags))];
    return { symbol: symbols.join(''), elements: [...symbols], tags };
  }
}
