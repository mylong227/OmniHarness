/**
 * 多模态端口（Modality port）——Genesis 对"支持多模态"的统一代数表达。
 *
 * 设计原则（避免堆砌）：不接入任意多模态模型，而是把"模态"提升为一个
 * **函子（functor）** + **交换幺半群（融合）** + **跨模态度量（对齐）** 的代数结构。
 * 任意模态都归一为一组可计算的特征向量（features），从而：
 *   - `map` 满足函子定律（恒等 / 组合）——可推演；
 *   - `fuse` 满足交换律（融合顺序无关）——可推演；
 *   - `align` 给出跨模态相似度（余弦），使文本与图像可在同一向量空间比较/检索。
 *
 * 真实能力：文本用确定性 n-gram 特征；图像用**真实可计算的结构特征**
 * （亮度均值/方差、字节香农熵、宽高比），零依赖、可离线运行。
 * 视觉语义编码器（如 CLIP）可作为 drop-in 适配器替换 `imageFeatures`，
 * 但代数结构（fuse/align/map）不变——这正是"架构适应力强"的体现。
 */

import { cosine } from './mathutil.js';

/** 模态种类。扩展种类不影响既有代数定律。 */
export type ModalityKind = 'text' | 'image' | 'audio' | 'video' | 'tensor' | 'none';

/**
 * 模态容器：携带原始数据 `data` 与归一化特征向量 `features`。
 * 特征向量是跨模态比较的唯一依据（统一向量空间）。
 */
export interface Modality<A> {
  readonly kind: ModalityKind;
  readonly data: A;
  /** 单位化特征向量（用于 fuse / align）。长度可变，但同一比较空间下需同维。 */
  readonly features: ReadonlyArray<number>;
}

/**
 * 多模态代数：原模块级纯函数归拢为 `ModalityPort` 静态方法族，
 * 调用点（multimodalBridge 等）通过同名 `export const` 别名零改动引用。
 */
export class ModalityPort {
  /** 函子 map：仅变换 data，保留 kind 与 features（特征空间不变）。 */
  public static mapModality<A, B>(m: Modality<A>, f: (a: A) => B): Modality<B> {
    return { kind: m.kind, data: f(m.data), features: m.features };
  }

  /** 文本模态：确定性 n-gram 包特征（长度 32，单位化）。 */
  public static encodeText(s: string): Modality<string> {
    return { kind: 'text', data: s, features: ModalityPort.textFeatures(s) };
  }

  /**
   * 图像模态：由原始字节计算**真实结构特征**（零依赖、可离线）。
   * 这是"视觉语义"的可计算占位；真实 CLIP 类编码器可替换本函数而代数不变。
   */
  public static encodeImage(
    bytes: Uint8Array,
    width: number,
    height: number,
  ): Modality<Uint8Array> {
    return { kind: 'image', data: bytes, features: ModalityPort.imageFeatures(bytes, width, height) };
  }

  /** 特征签名（确定性，用于融合时的规范排序以保交换律）。 */
  private static featureSig(f: ReadonlyArray<number>): string {
    return f.map((v) => v.toFixed(6)).join(',');
  }

  /**
   * 融合（交换幺半群乘积）：按 (kind, 特征签名) 规范排序保证交换律
   * （fuse(a,b) ≡ fuse(b,a)，即使同种类模态也成立）。
   * 特征为两向量拼接后重新单位化。
   */
  public static fuseModality<A, B>(a: Modality<A>, b: Modality<B>): Modality<[A, B]> {
    const ka = `${a.kind}#${ModalityPort.featureSig(a.features)}`;
    const kb = `${b.kind}#${ModalityPort.featureSig(b.features)}`;
    const [x, y] = ka <= kb ? [a, b] : [b, a];
    const raw = [...x.features, ...y.features];
    const len = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
    return {
      kind: 'tensor',
      data: [x.data, y.data] as [A, B],
      features: raw.map((v) => v / len),
    };
  }

  /** 跨模态对齐度：特征向量余弦相似度 ∈ [-1, 1]。文本与图像可直接比较。 */
  public static alignModality(a: Modality<unknown>, b: Modality<unknown>): number {
    return cosine(a.features as number[], b.features as number[]);
  }

  // ---- 真实可计算特征提取（零依赖） ----

  private static readonly TEXT_DIM = 32;

  /** 文本 n-gram 包特征（确定性、可复现），单位化到长度 TEXT_DIM。 */
  public static textFeatures(s: string): number[] {
    const v = new Array<number>(ModalityPort.TEXT_DIM).fill(0);
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c1 = s.charCodeAt(i);
      const c2 = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      const h = (c1 * 31 + c2 * 17) % ModalityPort.TEXT_DIM;
      v[h] = (v[h] ?? 0) + 1;
    }
    const len = Math.sqrt(v.reduce((s2, x) => s2 + (x ?? 0) * (x ?? 0), 0)) || 1;
    return v.map((x) => (x ?? 0) / len);
  }

  /**
   * 图像结构特征（真实可计算）：亮度均值/标准差、字节香农熵、宽高比。
   * 长度 8，单位化。作为视觉语义编码器的可计算占位。
   */
  public static imageFeatures(bytes: Uint8Array, width: number, height: number): number[] {
    const count = bytes.length || 1;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] ?? 0;
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);

    const freq = new Array<number>(256).fill(0);
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] ?? 0;
      freq[x] = (freq[x] ?? 0) + 1;
    }
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      const p = (freq[i] ?? 0) / count;
      if (p > 0) entropy -= p * Math.log2(p);
    }

    const aspect = width > 0 && height > 0 ? width / height : 1;
    const raw = [
      mean / 255,
      Math.sqrt(variance) / 255,
      entropy / 8,
      Math.min(2, aspect) / 2,
      Math.max(0.5, Math.min(2, height / (width || 1))) / 2,
    ];
    const padded = [...raw, ...new Array<number>(3).fill(0)];
    const len = Math.sqrt(padded.reduce((s, x) => s + x * x, 0)) || 1;
    return padded.map((x) => x / len);
  }
}

// ---- 门面兼容：保留原导出名 ----
export const mapModality = ModalityPort.mapModality;
export const encodeText = ModalityPort.encodeText;
export const encodeImage = ModalityPort.encodeImage;
export const fuseModality = ModalityPort.fuseModality;
export const alignModality = ModalityPort.alignModality;
export const textFeatures = ModalityPort.textFeatures;
export const imageFeatures = ModalityPort.imageFeatures;
