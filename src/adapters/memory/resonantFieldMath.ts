/**
 * 共振场数学原语（C7 收口）。
 *
 * 原 resonantFieldEngine.ts 的两个顶层内部纯函数迁入此处，避免 ResonantFieldEngine 上帝类越线（成员数红线）。
 */
import type { Spectrum } from '../../util/eigenspectrum.js';

/** 共振场纯函数工具（无状态，供 ResonantFieldEngine 调用）。 */
export class ResonantFieldMath {
  /**
   * C7 收口：原顶层内部函数迁入宿主类。
   * @param a Spectrum
   * @param b Spectrum
   * @returns Spectrum
   */
  public static avgSpectrum(a: Spectrum, b: Spectrum): Spectrum {
    const n = Math.max(a.values.length, b.values.length);
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const va = a.values[i] ?? 0;
      const vb = b.values[i] ?? 0;
      out[i] = (va + vb) / 2;
    }
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    return { bins: n, values: out.map((v) => v / norm) };
  }
  /**
   * C7 收口：原顶层内部函数迁入宿主类。
   * @param v number
   * @param lo number
   * @param hi number
   * @returns number
   */
  public static clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }
}
