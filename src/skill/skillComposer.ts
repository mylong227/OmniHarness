/**
 * 燧-1 莫尔转角组合算子（纯函数，零依赖）。
 * 组合算子是莫尔而非加权：两片能力光栅相对旋转 θ，乘积场浮现两片都没有的长波结构。
 * @beta
 */
import type { MoireMeta, MoireOptions, Skill } from './skill.js';

interface Resolved {
  n: number;
  blurR: number;
  step: number;
  minT: number;
  maxT: number;
  floor: number;
}

/**
 * 莫尔组合算子：原模块级纯函数归拢为 `MoireComposer` 静态方法族，
 * 调用点（固化器/skillComposer 测试）通过同名 `export const` 别名零改动引用。
 */
export class MoireComposer {
  private static resolve(opts?: MoireOptions): Resolved {
    return {
      n: opts?.fieldSize ?? 64,
      blurR: opts?.blurRadius ?? 2,
      step: opts?.thetaStepDeg ?? 3,
      minT: opts?.minTwistDeg ?? 3,
      maxT: opts?.maxTwistDeg ?? 87,
      floor: opts?.emergenceFloor ?? 0,
    };
  }

  /** 确定性 32 位字符串哈希（FNV-1a），用于从技能文本派生可复现能力场。 */
  private static hashText(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** 单个技能的能力场（N×N 正弦光栅）。显式声明优先，否则按文本确定性派生。 */
  static capabilityFieldOf(skill: Skill, n: number): number[][] {
    const explicit = skill.capabilityField;
    if (explicit && explicit.length === n * n) {
      const f: number[][] = [];
      for (let y = 0; y < n; y++) f.push(explicit.slice(y * n, (y + 1) * n));
      return f;
    }
    const seed = MoireComposer.hashText(
      `${skill.name}\u0000${skill.description}\u0000${skill.instructions}`,
    );
    const freq = 8; // 固定基础周期：两技能同频、仅朝向下组合，莫尔来自相对扭转（忠实原型验证）
    const ang = (((seed >>> 4) % 180) * Math.PI) / 180; // 光栅朝向（技能身份）
    const c = Math.cos(ang),
      s = Math.sin(ang);
    const f: number[][] = [];
    for (let y = 0; y < n; y++) {
      const row: number[] = [];
      for (let x = 0; x < n; x++) {
        const proj = (x * c + y * s) / n;
        row.push(Math.sin(2 * Math.PI * freq * proj));
      }
      f.push(row);
    }
    return f;
  }

  /** 将场 B 绕中心旋转 θ（重采样），模拟相对扭转。 */
  private static rotateSample(B: number[][], n: number, theta: number): number[][] {
    const c = Math.cos(theta),
      s = Math.sin(theta);
    const cx = (n - 1) / 2;
    const out: number[][] = [];
    for (let y = 0; y < n; y++) {
      const row: number[] = [];
      for (let x = 0; x < n; x++) {
        const dx = x - cx,
          dy = y - cx;
        const sx = Math.round(dx * c - dy * s + cx);
        const sy = Math.round(dx * s + dy * c + cx);
        if (sx < 0 || sy < 0 || sx >= n || sy >= n) row.push(0);
        else row.push(B[sy]![sx]!);
      }
      out.push(row);
    }
    return out;
  }

  /** 可分离均值模糊（低通），半径 r。 */
  private static boxBlur(P: number[][], n: number, r: number): number[][] {
    const tmp: number[][] = [];
    for (let y = 0; y < n; y++) {
      const row: number[] = [];
      for (let x = 0; x < n; x++) {
        let sum = 0,
          cnt = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < n) {
            sum += P[y]![xx]!;
            cnt++;
          }
        }
        row.push(sum / cnt);
      }
      tmp.push(row);
    }
    const out: number[][] = [];
    for (let y = 0; y < n; y++) {
      const row: number[] = [];
      for (let x = 0; x < n; x++) {
        let sum = 0,
          cnt = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < n) {
            sum += tmp[yy]![x]!;
            cnt++;
          }
        }
        row.push(sum / cnt);
      }
      out.push(row);
    }
    return out;
  }

  /**
   * 乘积场「涌现强度」：先去均值，再算低通能量 / 中心化总能量。
   * 该比值越高，说明乘积场含越多「两片各自都没有」的长波莫尔结构。
   */
  static emergenceAt(
    A: number[][],
    B: number[][],
    n: number,
    theta: number,
    blurR: number,
  ): number {
    const R = MoireComposer.rotateSample(B, n, theta);
    let mean = 0;
    const P: number[][] = [];
    for (let y = 0; y < n; y++) {
      const row: number[] = [];
      for (let x = 0; x < n; x++) {
        const v = A[y]![x]! * R[y]![x]!;
        row.push(v);
        mean += v;
      }
      P.push(row);
    }
    mean /= n * n;
    let totC = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) totC += (P[y]![x]! - mean) * (P[y]![x]! - mean);
    const blur = MoireComposer.boxBlur(P, n, blurR);
    let low = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) low += (blur[y]![x]! - mean) * (blur[y]![x]! - mean);
    return totC > 0 ? low / totC : 0;
  }

  /** 把两技能的合成指令融合成可用文本（复合技能真正可用，而非仅数学产物）。 */
  private static synthesizeInstructions(a: Skill, b: Skill): string {
    return [
      `# 莫尔组合技能（由 ${a.name} ⊗ ${b.name} 涌现）`,
      `## 来自 ${a.name}`,
      a.instructions.trim(),
      `## 来自 ${b.name}`,
      b.instructions.trim(),
    ].join('\n\n');
  }

  /**
   * 莫尔转角组合：固定 a 的场，对 b 的场扫描相对转角 θ，取涌现峰值 θ* 处的乘积场
   * 作为复合技能的能力场。返回的技能既是可用技能，又承载「两片都没有」的涌现长波。
   */
  static composeByTwist(a: Skill, b: Skill, opts?: MoireOptions): Skill {
    const { n, blurR, step, minT, maxT, floor } = MoireComposer.resolve(opts);
    const fa = MoireComposer.capabilityFieldOf(a, n);
    const fb = MoireComposer.capabilityFieldOf(b, n);
    let best = { theta: minT, emergence: -1 };
    for (let deg = minT; deg <= maxT; deg += step) {
      const e = MoireComposer.emergenceAt(fa, fb, n, (deg * Math.PI) / 180, blurR);
      if (e > best.emergence) best = { theta: deg, emergence: e };
    }
    // 涌现接纳下限：低于下限视为不具生产力（accepted=false），由固化器拒收。
    const accepted = best.emergence >= floor;
    // 取 θ* 处的乘积场作为复合能力场
    const R = MoireComposer.rotateSample(fb, n, (best.theta * Math.PI) / 180);
    const field: number[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field.push(fa[y]![x]! * R[y]![x]!);
    const meta: MoireMeta = {
      composedFrom: [a.name, b.name],
      twistDeg: best.theta,
      emergence: best.emergence,
      accepted,
      fieldSize: n,
    };
    return {
      name: `moire:${a.name}+${b.name}`,
      description: `莫尔组合技能（θ*=${best.theta}°，涌现强度=${best.emergence.toFixed(3)}）：融合 ${a.name} 与 ${b.name} 的涌现长波能力。`,
      instructions: MoireComposer.synthesizeInstructions(a, b),
      tags: [...(a.tags ?? []), ...(b.tags ?? []), 'moire'],
      capabilityField: field,
      moire: meta,
    };
  }
}

// ---- 门面兼容：保留原导出名 ----
export const capabilityFieldOf = MoireComposer.capabilityFieldOf;
export const emergenceAt = MoireComposer.emergenceAt;
export const composeByTwist = MoireComposer.composeByTwist;
