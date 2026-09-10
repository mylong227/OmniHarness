/**
 * 频率域本征谱工具（燧-3 共振寻址底座）。零依赖。
 *
 * 把文本/频率签名映射为归一化频谱：检索不再依靠指针或向量几何距离，
 * 而是"发射频谱探针 → 与其本征模共振的条目自行聚集显现"。同频即显、异频即散。
 */

/**
 * 本征谱工具：原模块级纯函数归拢为 `EigenSpectrum` 静态方法族，
 * 调用点（contextEngine / repoMapContext 等）通过同名 `export const` 别名零改动引用。
 */
export class EigenSpectrum {
  /** 共振谱 bin 数（与燧-3 记忆引擎同源；contextEngine / repoMapContext 共用，禁止各自硬编码）。 */
  static readonly RESONANCE_BINS = 257;

  /** FNV-1a 32-bit 哈希（与 skillComposer 同源，零依赖）。 */
  static fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * 中英文兼容分词：小写去标点后逐字符。
   * 用字符级频率映射（charCode % bins）而非 bigram 哈希——不同汉字落到不同 bin，
   * 跨主题文本在频率域近乎正交，区分度远高于弥散哈希。
   */
  static tokenizeChunks(text: string): string[] {
    const clean = text.toLowerCase().replace(/[\s\p{P}]+/gu, '');
    return Array.from(clean);
  }

  private static gaussianSmooth(values: readonly number[], sigma: number): number[] {
    const n = values.length;
    const out = new Array<number>(n).fill(0);
    const inv = 1 / (2 * sigma * sigma);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) {
        const d = i - j;
        s += values[j]! * Math.exp(-(d * d) * inv);
      }
      out[i] = s;
    }
    return out;
  }

  private static normalize(values: readonly number[]): number[] {
    const norm = Math.sqrt(values.reduce((a, v) => a + v * v, 0)) || 1;
    return values.map((v) => v / norm);
  }

  /**
   * 由文本派生本征频谱：每个字符映射到基频 bin（charCode % bins），叠加 2f/3f 谐波
   * （模拟振动板本征模），高斯平滑（σ=1，赋予频响带宽），L2 归一化。
   */
  static eigenSpectrum(text: string, bins = EigenSpectrum.RESONANCE_BINS): Spectrum {
    const raw = new Array<number>(bins).fill(0);
    for (const ch of EigenSpectrum.tokenizeChunks(text)) {
      const b = ch.charCodeAt(0) % bins;
      raw[b] = (raw[b] ?? 0) + 1;
      raw[(b * 2) % bins] = (raw[(b * 2) % bins] ?? 0) + 0.5;
      raw[(b * 3) % bins] = (raw[(b * 3) % bins] ?? 0) + 0.25;
    }
    const sm = EigenSpectrum.gaussianSmooth(raw, 1);
    return { bins, values: EigenSpectrum.normalize(sm) };
  }

  /** 由裸频率值构造频谱（用于直接发射频率签名探针，非自然语言）。 */
  static spectrumFromValues(values: readonly number[], bins = values.length): Spectrum {
    const arr = new Array<number>(bins).fill(0);
    for (let i = 0; i < values.length && i < bins; i++) arr[i] = values[i] ?? 0;
    return { bins, values: EigenSpectrum.normalize(arr) };
  }

  /**
   * 共振度：两频谱的余弦相似度（频率域）。两者均已 L2 归一化 → 点积即余弦。
   * 同频 → ≈1；异频 → ≈0；频率偏移 ±1 bin 因高斯平滑仍部分共振（频响特性）。
   */
  static resonance(a: Spectrum, b: Spectrum): number {
    const n = Math.min(a.values.length, b.values.length);
    let dot = 0;
    for (let i = 0; i < n; i++) dot += a.values[i]! * b.values[i]!;
    return dot;
  }
}

/** 一条归一化频谱：values 已 L2 归一化，长度 = bins。 */
export interface Spectrum {
  readonly bins: number;
  readonly values: number[];
}

// ---- 门面兼容：保留原导出名 ----
export const RESONANCE_BINS = EigenSpectrum.RESONANCE_BINS;
export const fnv1a = EigenSpectrum.fnv1a;
export const tokenizeChunks = EigenSpectrum.tokenizeChunks;
export const eigenSpectrum = EigenSpectrum.eigenSpectrum;
export const spectrumFromValues = EigenSpectrum.spectrumFromValues;
export const resonance = EigenSpectrum.resonance;
