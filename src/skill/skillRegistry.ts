import type { SkillPort, MoireOptions } from '../ports/skill.js';
import type { MoireMeta } from './skill.js';
import type { Skill } from './skill.js';
import { composeByTwist as moireCompose } from './moireComposer.js';

/**
 * @beta
 * 技能注册表：注册/列举/按需匹配（命中 tag 或名称才注入上下文）。
 * 同时实现 SkillPort，提供燧-1 莫尔转角组合算子。
 */
export class SkillRegistry implements SkillPort {
  private readonly skills = new Map<string, Skill>();

  /** 注册技能；重名即抛错。 */
  public register(skill: Skill): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`技能重复注册: ${skill.name}`);
    }
    this.skills.set(skill.name, skill);
  }

  /** 原地替换既有技能（CRISPR 定点编辑用）：存在则覆盖，不存在则注册。 */
  public replace(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /** 全部技能。 */
  public list(): readonly Skill[] {
    return [...this.skills.values()];
  }

  /** 按需匹配：文本包含技能名或任一 tag 即命中。 */
  public match(text: string): readonly Skill[] {
    const lower = text.toLowerCase();
    return this.list().filter((skill) => this.isHit(skill, lower));
  }

  /** 是否命中。 */
  private isHit(skill: Skill, lowerText: string): boolean {
    if (lowerText.includes(skill.name.toLowerCase())) {
      return true;
    }
    return (skill.tags ?? []).some((tag) => lowerText.includes(tag.toLowerCase()));
  }

  /** 按名称取技能。 */
  public get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** 渲染技能指令（注入上下文的文本）。若为莫尔组合技能，附涌现元数据。 */
  public render(skill: Skill): string {
    if (skill.moire) {
      const m = skill.moire;
      return `# 技能：${skill.name}（莫尔组合 θ*=${m.twistDeg}° 涌现=${m.emergence.toFixed(3)}）\n${skill.instructions}`;
    }
    return `# 技能：${skill.name}\n${skill.instructions}`;
  }

  /**
   * 莫尔转角组合：调用燧-1 组合算子生成复合技能，并自动注册（重名抛错）。
   * 返回承载「两片都没有的涌现长波」的可用技能。
   */
  public composeByTwist(a: Skill, b: Skill, opts?: MoireOptions): Skill & { moire: MoireMeta } {
    const composed = moireCompose(a, b, opts);
    this.register(composed);
    return composed as Skill & { moire: MoireMeta };
  }
}
