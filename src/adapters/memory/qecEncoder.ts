/**
 * @maturity L0 — 用冗余/校验思想；非量子，宜称「轨迹级校验关系 + 显式冗余」
 * @maturityEvidence tests/unit/qec.test.ts
 */
import type { LongTermMemoryPort, MemoryFact } from '../../ports/longTermMemory.js';
import type { QECEncoderPort, QECStatus, QECReport } from '../../ports/qec.js';

const SYNDROME_TOPIC = '__qec_syndrome__';

/** QEC 编码器选项（fail-closed 边界夹紧）。 */
export interface QECOptions {
  /** 网格列数（每行字符数，决定 2D 奇偶症状维度）。默认 8。 */
  readonly cols?: number;
}

interface Parities {
  readonly rows: number[];
  readonly colsArr: number[];
  readonly nRows: number;
}

/**
 * QEC 式记忆编码器（I-P1-3）。把长期记忆建成"稳定子+症状"编码块。
 *
 * 为每条事实计算一个二维奇偶症状（行/列 XOR），存储为同名 syndrome 事实。校验时只读症状
 * 即可：单点 corrupt 表现为"恰一行 + 恰一列"奇偶失配 → 交点即错误位 → 定位并纠正；
 * 多点 corrupt 无法唯一定位 → 标记 uncorrectable（fail-closed，绝不静默接受损坏内容）。
 * 直击灾难性遗忘、抗存储损坏，是向量库/副本记忆在代数上不具备的"可校验纠错"维度。
 *
 * 零运行时依赖；syndrome 落同一记忆端口（topic `__qec_syndrome__`），跨进程重启仍可读回。
 *
 * 措辞边界（2026-09-12，见 docs/library/20-physics.md §8）：名称沿用 QEC（Quantum Error
 * Correction），但**不涉及任何量子力学**——本实现只是「**轨迹级校验关系 + 显式冗余**」：
 * 用二维奇偶构造校验关系、用 syndrome 事实提供冗余，靠关系数多于未知数来定位错误。
 * 保留 QEC 命名是因为它是社区通名且 API 已稳定；理解时应读作「纠删 / 校验码」。
 */
export class QECEncoder implements QECEncoderPort {
  public readonly name = 'qec-encoder';
  private readonly memory: LongTermMemoryPort;
  private readonly cols: number;

  public constructor(memory: LongTermMemoryPort, opts: QECOptions = {}) {
    this.memory = memory;
    this.cols = Math.max(2, Math.floor(opts.cols ?? 8));
  }

  public encode(id: string): void {
    const fact = this.memory.get(id);
    if (fact === undefined) return;
    const p = this.gridParities(fact.text, this.cols);
    const text = `QEC|${this.cols}|${p.rows.join('.')}|${p.colsArr.join('.')}`;
    const sid = `__qec_${id}`;
    const existing = this.memory.get(sid);
    if (existing !== undefined) {
      this.memory.update(sid, { text });
    } else {
      this.memory.remember({
        id: sid,
        text,
        topic: SYNDROME_TOPIC,
        importance: 1,
        createdAt: new Date().toISOString(),
        sessionId: 'qec',
        source: 'tool',
      });
    }
  }

  public verify(id: string): QECStatus {
    const fact = this.memory.get(id);
    if (fact === undefined) return 'uncorrectable';
    const syn = this.memory.get(`__qec_${id}`);
    if (syn === undefined) return 'ok'; // 未编码，无基线可查
    const cur = this.gridParities(fact.text, this.cols);
    const stored = this.parseSyndrome(syn.text);
    if (stored === null || stored.cols !== this.cols) return 'uncorrectable';

    const badRows = cur.rows.filter((r, i) => r !== stored.rows[i]).length;
    const badCols = cur.colsArr.filter((c, j) => c !== stored.colsArr[j]).length;
    if (badRows === 0 && badCols === 0) return 'ok';
    // 阈值定理风味：仅当恰一行 + 恰一列失配（唯一定位一个错误位）才可纠正。
    if (badRows === 1 && badCols === 1) return 'corrected';
    return 'uncorrectable';
  }

  public repair(id: string): QECStatus {
    const status = this.verify(id);
    if (status !== 'corrected') return status; // fail-closed：非单点错误绝不擅自改写

    const fact = this.memory.get(id)!;
    const syn = this.memory.get(`__qec_${id}`)!;
    const cur = this.gridParities(fact.text, this.cols);
    const stored = this.parseSyndrome(syn.text)!;

    // 定位错误单元 (ri, cj)。
    let ri = -1;
    let cj = -1;
    for (let i = 0; i < cur.rows.length; i++) if (cur.rows[i] !== stored.rows[i]) ri = i;
    for (let j = 0; j < cur.colsArr.length; j++) if (cur.colsArr[j] !== stored.colsArr[j]) cj = j;
    if (ri < 0 || cj < 0) return 'uncorrectable'; // 无法唯一定位

    const codes = [...fact.text].map((ch) => ch.charCodeAt(0));
    const idx = ri * this.cols + cj;
    const corrupted = codes[idx] ?? 0;
    // 错误位 = 当前行(列)奇偶差；原始码 = 损坏码 XOR 错误位。
    const errBit = cur.rows[ri]! ^ stored.rows[ri]!;
    const original = corrupted ^ errBit;
    codes[idx] = original;
    const fixed = String.fromCharCode(...codes);

    this.memory.update(id, { text: fixed });
    this.encode(id); // 刷新症状
    return 'corrected';
  }

  public repairAll(): QECReport {
    let checked = 0;
    let corrected = 0;
    let uncorrectable = 0;
    for (const f of this.memory.all()) {
      if (f.topic === SYNDROME_TOPIC) continue;
      checked++;
      const s = this.verify(f.id);
      if (s === 'corrected') {
        this.repair(f.id);
        corrected++;
      } else if (s === 'uncorrectable') {
        uncorrectable++;
      }
    }
    return { checked, corrected, uncorrectable };
  }

  private gridParities(text: string, cols: number): Parities {
    const codes = [...text].map((ch) => ch.charCodeAt(0));
    const nRows = Math.max(1, Math.ceil(codes.length / cols));
    const rows = new Array<number>(nRows).fill(0);
    const colsArr = new Array<number>(cols).fill(0);
    for (let i = 0; i < codes.length; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      rows[r] = (rows[r]! ^ codes[i]!) & 0xff;
      colsArr[c] = (colsArr[c]! ^ codes[i]!) & 0xff;
    }
    return { rows, colsArr, nRows };
  }

  private parseSyndrome(text: string): { rows: number[]; colsArr: number[]; cols: number } | null {
    // 格式：QEC|<cols>|<rowParities>|<colParities>
    const parts = text.split('|');
    if (parts.length !== 4 || parts[0] !== 'QEC') return null;
    const cols = Number(parts[1]);
    const rows = parts[2]!.split('.').map((x) => Number(x) || 0);
    const colsArr = parts[3]!.split('.').map((x) => Number(x) || 0);
    if (!Number.isFinite(cols) || cols < 2) return null;
    return { rows, colsArr, cols };
  }
}
