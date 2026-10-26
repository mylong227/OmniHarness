/**
 * 文本 CRDT（RGA，Replicated Growable Array）。
 *
 * ## 为什么需要它（与 diff3 的分工）
 *
 * diff3 面向「整文件 + 共同祖先 + 一次性提交」；CRDT 面向「多人实时编辑、无中心、离线」：
 * 每个字符有全局唯一 id 与 `after` 引用，插入/删除可交换、可合并、幂等。两者不是替代关系：
 * 本仓文件写入仍用 diff3（整文件语义），CRDT 作为未来协同编辑的**可证收敛原语**。
 *
 * ## 契约
 *
 * - 节点 id：`<replica>:<seq>`（seq 每副本单调递增）；
 * - 插入：`after` 指向父节点 id（`null` = 文档头）；同父节点下按 `(replica, seq)` 排序；
 * - 删除：墓碑（tombstone），不物理移除，保证并发合并仍能定位；
 * - 合并：按 id 取并集，墓碑 OR；同一份操作集在任意副本上物化结果一致。
 *
 * @maturity L2 — 真实 RGA 节点/墓碑/确定性物化；未做富文本属性、undo、垃圾回收
 * @maturityEvidence tests/unit/textCrdt.test.ts
 */

/** CRDT 节点（内部/导出用于合并）。 */
export interface CrdtNode {
  /** 全局唯一 id（`replica:seq`）。 */
  readonly id: string;
  /** 父节点 id（null = 文档头）。 */
  readonly after: string | null;
  /** 字符（UTF-16 code unit）。 */
  readonly char: string;
  /** 副本 id。 */
  readonly replica: string;
  /** 副本内序号。 */
  readonly seq: number;
  /** 是否被删除（墓碑）。 */
  readonly deleted: boolean;
}

/** 插入操作。 */
export interface CrdtInsertOperation {
  readonly kind: 'insert';
  readonly node: CrdtNode;
}

/** 删除操作。 */
export interface CrdtDeleteOperation {
  readonly kind: 'delete';
  readonly id: string;
}

/** CRDT 操作。 */
export type CrdtOperation = CrdtInsertOperation | CrdtDeleteOperation;

/** RGA 文本副本。 */
export class TextCrdt {
  /** 节点表（id → 节点）。 */
  private readonly nodes = new Map<string, CrdtNode>();
  /** 各副本下一个序号。 */
  private readonly seqByReplica = new Map<string, number>();
  /** 本副本 id。 */
  private readonly replica: string;

  /**
   * @param replica 副本 id（同机多副本也必须不同）。
   */
  public constructor(replica: string) {
    if (replica === '') throw new Error('replica 不能为空');
    this.replica = replica;
  }

  /**
   * 本副本 id。
   * @returns 副本 id。
   */
  public replicaId(): string {
    return this.replica;
  }

  /**
   * 在当前可见文本的 `index` 处插入文本（生成并应用操作）。
   * @param index 可见字符下标（0..length）。
   * @param text 插入文本。
   * @returns 生成的操作（供广播）。
   * @throws RangeError 下标越界。
   */
  public insert(index: number, text: string): readonly CrdtOperation[] {
    const visible = this.visibleNodes();
    if (index < 0 || index > visible.length) {
      throw new RangeError(
        `insert index=${String(index)} 越界，应在 [0,${String(visible.length)}]`,
      );
    }
    let after = index === 0 ? null : (visible[index - 1]?.id ?? null);
    const ops: CrdtOperation[] = [];
    for (const char of text) {
      const seq = (this.seqByReplica.get(this.replica) ?? 0) + 1;
      this.seqByReplica.set(this.replica, seq);
      const node: CrdtNode = {
        id: `${this.replica}:${String(seq)}`,
        after,
        char,
        replica: this.replica,
        seq,
        deleted: false,
      };
      this.apply({ kind: 'insert', node });
      ops.push({ kind: 'insert', node });
      after = node.id;
    }
    return ops;
  }

  /**
   * 删除当前可见文本的 `[index, index+length)`（生成并应用墓碑操作）。
   * @param index 可见字符下标。
   * @param length 删除长度。
   * @returns 生成的操作。
   * @throws RangeError 下标/长度越界。
   */
  public delete(index: number, length: number): readonly CrdtOperation[] {
    const visible = this.visibleNodes();
    if (index < 0 || length < 0 || index + length > visible.length) {
      throw new RangeError(`delete [${String(index)},${String(index + length)}) 越界`);
    }
    const ops: CrdtOperation[] = [];
    for (const node of visible.slice(index, index + length)) {
      this.apply({ kind: 'delete', id: node.id });
      ops.push({ kind: 'delete', id: node.id });
    }
    return ops;
  }

  /**
   * 应用一个远程/本地操作（幂等：重复插入同 id 忽略，重复删除仍为墓碑）。
   * @param op 操作。
   * @returns 无返回值。
   */
  public apply(op: CrdtOperation): void {
    if (op.kind === 'delete') {
      const existing = this.nodes.get(op.id);
      if (existing !== undefined) this.nodes.set(op.id, { ...existing, deleted: true });
      return;
    }
    if (this.nodes.has(op.node.id)) return;
    this.nodes.set(op.node.id, op.node);
    const current = this.seqByReplica.get(op.node.replica) ?? 0;
    if (op.node.seq > current) this.seqByReplica.set(op.node.replica, op.node.seq);
  }

  /**
   * 合并另一个副本的全部节点（墓碑 OR）。
   * @param other 另一个副本。
   * @returns 无返回值。
   */
  public merge(other: TextCrdt): void {
    for (const node of other.nodes.values()) {
      const existing = this.nodes.get(node.id);
      if (existing === undefined) {
        this.nodes.set(node.id, node);
        const current = this.seqByReplica.get(node.replica) ?? 0;
        if (node.seq > current) this.seqByReplica.set(node.replica, node.seq);
      } else if (node.deleted && !existing.deleted) {
        this.nodes.set(node.id, { ...existing, deleted: true });
      }
    }
  }

  /**
   * 物化当前文本（确定性：同父节点的子节点按 `(replica, seq)` 排序）。
   * @returns 文本。
   */
  public toString(): string {
    return this.visibleNodes()
      .map((node) => node.char)
      .join('');
  }

  /**
   * 当前可见节点数。
   * @returns 可见字符数。
   */
  public length(): number {
    return this.visibleNodes().length;
  }

  /**
   * 导出全部节点（用于持久化/合并）。
   * @returns 节点数组。
   */
  public snapshot(): readonly CrdtNode[] {
    return [...this.nodes.values()];
  }

  /**
   * 可见节点（深度优先，子节点确定性排序）。
   * @returns 可见节点数组。
   */
  private visibleNodes(): CrdtNode[] {
    const children = new Map<string | null, CrdtNode[]>();
    for (const node of this.nodes.values()) {
      const list = children.get(node.after) ?? [];
      list.push(node);
      children.set(node.after, list);
    }
    for (const list of children.values()) {
      list.sort((a, b) => (a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : a.seq - b.seq));
    }
    const out: CrdtNode[] = [];
    const visit = (parent: string | null): void => {
      for (const node of children.get(parent) ?? []) {
        if (!node.deleted) out.push(node);
        visit(node.id);
      }
    };
    visit(null);
    return out;
  }
}
