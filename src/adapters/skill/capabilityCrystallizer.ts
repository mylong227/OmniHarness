/**
 * 相变固化器（P2, I-P2-5）。
 *
 * 微观粒子/对称破缺隐喻（Higgs 相变）：以"经验密度"为序参量，当某个技能组合的
 * 使用密度越过临界阈值，该"常用组合"便冻结成一条稳定的原生能力（一次组合、永久可用，
 * 不再每次临时重新组合）。
 *
 * 设计铁律（fail-closed / 加法式）：
 * - 冻结**只新增**原生能力，绝不删改源组合或任何既有能力。
 * - 组合失败（技能缺失）或名称冲突→跳过并计入 `skipped`，不抛错、不静默覆盖。
 * - 越阈后密度归零（序参量回落），已冻结组合进入 `frozenKeys`，后续只计 `alreadyFrozen`，
 *   不再重复注册。
 *
 * 组合复用燧-1 莫尔转角算子（composeByTwist），但走纯函数入口（不自动注册中间产物），
 * 仅把最终组合结果以 `frozen` 标记注册为原生能力。
 */
import type { Skill } from '../../skill/skill.js';
import type { SkillPort, MoireOptions } from '../../ports/skill.js';
import { composeByTwist as moireCompose } from '../../skill/skillComposer.js';
import type {
  CapabilityCrystallizerPort,
  CrystallizationReport,
  FrozenCapability,
} from '../../ports/capability.js';

/** 相变固化器选项。 */
export interface CapabilityCrystallizerOptions {
  /** 技能端口（通常是受种的 SkillRegistry），供解析组合成员与注册冻结能力。 */
  readonly skillPort: SkillPort;
  /** 临界阈值：经验密度越过即冻结（默认 3）。 */
  readonly densityThreshold?: number;
  /** 观测指数衰减（EMA 因子，默认 1 = 简单累计计数；<1 表示近期使用权重更高）。 */
  readonly decay?: number;
  /** 莫尔组合能力场边长（默认 32，须与燧-1 基准一致）。 */
  readonly fieldSize?: number;
  /** 越阈冻结后把该组合密度归零（序参量回落，默认 true）。 */
  readonly resetOnCrystallize?: boolean;
  /** 莫尔涌现接纳下限（默认 0 = 全接纳）：组合峰值涌现低于此值视为不具生产力、拒收不冻结。 */
  readonly emergenceFloor?: number;
}

/** 确定性短哈希（djb2 → base36），用于派生稳定冻结名，无需加密库。 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 相变固化器。 */
export class CapabilityCrystallizer implements CapabilityCrystallizerPort {
  private readonly port: SkillPort;
  private readonly threshold: number;
  private readonly decay: number;
  private readonly moireOpts: MoireOptions | undefined;
  private readonly resetOnCrystallize: boolean;
  private readonly densities = new Map<string, number>();
  private readonly frozenKeys = new Set<string>();
  private readonly frozenList: FrozenCapability[] = [];

  public constructor(opts: CapabilityCrystallizerOptions) {
    this.port = opts.skillPort;
    this.threshold = opts.densityThreshold ?? 3;
    this.decay = opts.decay ?? 1;
    this.moireOpts =
      opts.fieldSize !== undefined || opts.emergenceFloor !== undefined
        ? {
            ...(opts.fieldSize !== undefined ? { fieldSize: opts.fieldSize } : {}),
            ...(opts.emergenceFloor !== undefined ? { emergenceFloor: opts.emergenceFloor } : {}),
          }
        : undefined;
    this.resetOnCrystallize = opts.resetOnCrystallize ?? true;
  }

  /** 组合键：去重 + 排序（序参量对成员顺序无关）。 */
  private comboKey(combo: readonly string[]): string {
    return [...new Set(combo)].sort().join('|');
  }

  /** 观测一次组合使用：经验密度累加（ETA 衰减）。单技能不构成组合，忽略。 */
  public observe(combination: readonly string[]): void {
    if (combination.length < 2) return;
    const key = this.comboKey(combination);
    const prev = this.densities.get(key) ?? 0;
    this.densities.set(key, prev * this.decay + 1);
  }

  /** 当前经验密度（序参量取值）。 */
  public density(combination: readonly string[]): number {
    return this.densities.get(this.comboKey(combination)) ?? 0;
  }

  /** 已冻结能力清单。 */
  public frozen(): readonly FrozenCapability[] {
    return [...this.frozenList];
  }

  /** 越阈冻结：遍历密度越界的组合，冻结为原生能力；返回本轮报告（fail-closed / 加法式）。 */
  public crystallize(): CrystallizationReport {
    const frozen: string[] = [];
    let alreadyFrozen = 0;
    const skipped: string[] = [];
    const emergences: number[] = [];
    let rejectedByFloor = 0;
    const toReset: string[] = [];

    for (const [key, density] of this.densities) {
      if (density < this.threshold) continue;
      toReset.push(key);
      if (this.frozenKeys.has(key)) {
        alreadyFrozen++;
        continue;
      }
      const members = key.split('|');
      // 解析组合成员；任一缺失 → 跳过（fail-closed，不静默编造）。
      const skills: Skill[] = [];
      let ok = true;
      for (const name of members) {
        const s = this.port.get(name);
        if (s === undefined) {
          ok = false;
          break;
        }
        skills.push(s);
      }
      if (!ok || skills.length < 2) {
        skipped.push(key);
        continue;
      }
      // 莫尔组合（纯函数入口，不自动注册中间产物）。
      let composed: Skill = skills[0]!;
      for (let i = 1; i < skills.length; i++) {
        composed = moireCompose(composed, skills[i]!, this.moireOpts);
      }
      // 捕获真实涌现（composeByTwist 经 emergenceAt 算出），低于接纳下限则拒收（不冻结）。
      const em = composed.moire?.emergence ?? 0;
      emergences.push(em);
      if (composed.moire?.accepted === false) {
        skipped.push(key);
        rejectedByFloor++;
        continue;
      }
      const frozenName = `crystal:${shortHash(key)}`;
      const frozenSkill: Skill = {
        ...composed,
        name: frozenName,
        description: `相变固化原生能力（来源：${members.join(' + ')}）`,
        frozen: true,
        frozenFrom: members,
      };
      // 注册为原生能力：名称冲突 → 跳过（绝不覆盖既有能力）。
      try {
        this.port.register(frozenSkill);
      } catch {
        skipped.push(key);
        continue;
      }
      this.frozenKeys.add(key);
      this.frozenList.push({ name: frozenName, from: members, density });
      frozen.push(frozenName);
    }

    if (this.resetOnCrystallize) {
      for (const key of toReset) this.densities.set(key, 0);
    }
    return {
      threshold: this.threshold,
      frozen,
      alreadyFrozen,
      skipped,
      emergences,
      rejectedByFloor,
    };
  }
}
