/**
 * 能力覆盖基准（P1 进化闭环的"真实基准"）。
 *
 * 把技能的能力场（N×N 正弦光栅）与"任务画像"做结构重叠度量。
 * 核心洞察（来自 I-P0-1 莫尔组合实证）：单能力技能场是「单一频率光栅」，
 * 与「需同时具备 A 与 B 的联合画像」（= A 场 × B 场 的乘积场）频率正交 → 重叠≈0；
 * 莫尔组合技能场本身是「两片乘积」，与联合画像频率结构同构 → 重叠高。
 * 因此该基准能确定性地证明：组合技能在联合任务上 > 任一单技能（"市面唯一"增益）。
 *
 * 纯函数、零依赖、确定性、可单测。EvolutionGate 默认即注入此基准。
 */
import type { Skill } from '../skill/skill.js';
import { capabilityFieldOf } from '../skill/skillComposer.js';

/** 扁平化二维场。 */
function flatten(field: readonly (readonly number[])[]): number[] {
  const out: number[] = [];
  for (const row of field) {
    for (const v of row) out.push(v);
  }
  return out;
}

/** 去均值（中心化）。 */
function center(flat: readonly number[]): number[] {
  let m = 0;
  for (const v of flat) m += v;
  m /= flat.length;
  return flat.map((v) => v - m);
}

/**
 * 去均值后余弦相似，裁剪到 [0,1]。
 * 两场结构越像（频率/相位越接近）越高；正交结构 → 0。
 */
export function fieldMatch(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : Math.max(0, num / den);
}

/**
 * 联合能力画像：任务"需同时具备 a 与 b"时，参考场 = a 场 × b 场（莫尔/涌现结构）。
 * 中心化后返回扁平数组。
 */
export function jointProfile(a: Skill, b: Skill, n: number): number[] {
  const fa = flatten(capabilityFieldOf(a, n));
  const fb = flatten(capabilityFieldOf(b, n));
  const prod = fa.map((v, i) => v * fb[i]!);
  return center(prod);
}

/**
 * 能力覆盖基准：候选技能场与参考联合场的重叠度（0..1）。
 * 单能力技能与联合场频率正交 → ≈0；莫尔组合技能 → 高。
 * 适用于"已知联合任务画像"的针对性 A/B；若只关心"是否携带复合涌现结构"，用 `moireEnergy`。
 */
export function capabilityCoverage(skill: Skill, profile: readonly number[], n: number): number {
  const raw =
    skill.capabilityField !== undefined && skill.capabilityField.length === n * n
      ? [...skill.capabilityField]
      : flatten(capabilityFieldOf(skill, n));
  return fieldMatch(center(raw), profile as number[]);
}

/**
 * 莫尔/涌现能量：候选能力场「低通能量 / 总中心化能量」（0..1）。
 * 越高 = 场携带越多长波乘积（莫尔）结构。
 *
 * 这是与技能文本无关、且因各向同性模糊而稳定分离的判别量：
 * - 单能力技能场是单一频率光栅，模糊后仅被均匀衰减 → 能量比 ≈ 常数（~0.28）；
 * - 莫尔组合技能场是两片乘积，含低频莫尔项，模糊后低频幸存 → 能量比显著更高（~0.45+）。
 * 故任何组合技能都稳定高于单技能，适合作为"联合任务需要复合能力"的通用基准。
 */
export function moireEnergy(skill: Skill, n: number, blurR = 2): number {
  const raw =
    skill.capabilityField !== undefined && skill.capabilityField.length === n * n
      ? [...skill.capabilityField]
      : flatten(capabilityFieldOf(skill, n));
  const len = raw.length;
  if (len === 0) return 0;
  let mean = 0;
  for (const v of raw) mean += v;
  mean /= len;
  const blur = new Array<number>(len).fill(0);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      let c = 0;
      for (let ky = -blurR; ky <= blurR; ky++) {
        for (let kx = -blurR; kx <= blurR; kx++) {
          const xx = x + kx;
          const yy = y + ky;
          if (xx >= 0 && xx < n && yy >= 0 && yy < n) {
            s += raw[yy * n + xx]!;
            c++;
          }
        }
      }
      blur[y * n + x] = s / c;
    }
  }
  let tot = 0;
  let low = 0;
  for (let i = 0; i < len; i++) {
    const d = raw[i]! - mean;
    tot += d * d;
    const b = blur[i]! - mean;
    low += b * b;
  }
  return tot > 0 ? low / tot : 0;
}
