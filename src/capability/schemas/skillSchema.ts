/**
 * 首个资产类型描述符：技能（ADR-0009 · EVOLVIX_SPEC §3「委托既有 moireEnergy 基准」）。
 *
 * 为什么技能是第一个实例：它已经是生产对象（注入上下文、莫尔组合、CRISPR 编辑、固化器冻结），
 * 把它先搬上统一协议，等于用**已有全部判据**给协议做体检——协议若在技能上不成立，后面免谈。
 *
 * 三条设计要点：
 * 1. **校验判据沿用既有口径**：`Skill` 的必需字段（`name` / `description` / `instructions` 非空、
 *    `tags` 若给必须是字符串数组）与 `ConfigError.normalizeSkillEntries` 同源——不另立一套「资产版技能校验」，
 *    否则同一条技能在配置入口与注册入口会得到两个答案；
 * 2. **评估契约委托门禁基准**：`Benchmark.moireEnergy(skill, 64)`——与 ring ④ 门禁、ring ⑥ CRISPR
 *    差异测试**同一把尺**（`RlvrController.defaultGateScore` 的口径），新协议不引入第二把尺；
 * 3. **默认档位如实**：`core` + `os-sandbox`——出厂技能不假装需要隔离，但也不假装「进程内更安全」；
 *    进化产物由注册表在 `put` 时按来源收紧（`evolved`），那是 Wave C 的档位阶梯的入口。
 *
 * @maturity L1 — 校验正/负例与「评估尺与门禁同源」判据钉死（含去掉校验即红的变异）
 * @maturityEvidence tests/unit/skillSchema.test.ts
 */
import { Benchmark } from '../../evolution/benchmark.js';
import type {
  AssetBenchmark,
  CapabilitySchema,
  EvalContext,
  SchemaValidation,
} from '../../ports/capability.js';
import type { Skill } from '../../skill/skill.js';

/** 技能能力场边长（与门禁默认基准同口径：见 `RlvrController.DEFAULT_MOIRE_FIELD_SIZE` 的实测依据）。 */
const SKILL_FIELD_SIZE = 64;

/**
 * 技能类型描述符。
 *
 * 既是 `CapabilitySchema` 的实例（供注册表使用），也是技能资产校验与打分的**唯一实现点**。
 */
export class SkillSchema implements CapabilitySchema {
  /** 类型键（资产协议的注册键）。 */
  public readonly kind = 'skill';
  /** 契约版本（当前唯一合法值）。 */
  public readonly version = 1;
  /** 默认信任档：出厂/人工注册的技能按「内置」起步（进化产物由注册表收紧）。 */
  public readonly defaultTrustTier = 'core' as const;
  /** 默认隔离档：走既有 OS 沙箱档（技能本身不执行代码，真正执行的是模型采样，见 Wave C）。 */
  public readonly defaultIsolation = 'os-sandbox' as const;
  /** 台账语义：技能状态变化走晋升链、快照粒度 = 全注册表（Wave A 台账已实现的那一种）。 */
  public readonly ledgerSemantics = { chain: 'promotion', snapshot: 'registry-full' } as const;

  /**
   * 结构校验：技能必需字段非空、可选字段类型正确。
   * @param asset 待校验资产
   * @returns 校验结论（失败带可行动原因）
   */
  public validate(asset: unknown): SchemaValidation {
    if (typeof asset !== 'object' || asset === null) {
      return { ok: false, reason: '技能资产必须是对象' };
    }
    const candidate = asset as Partial<Record<'name' | 'description' | 'instructions', unknown>> & {
      readonly tags?: unknown;
    };
    for (const field of ['name', 'description', 'instructions'] as const) {
      const value = candidate[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, reason: `技能字段 ${field} 缺失或为空` };
      }
    }
    if (candidate.tags !== undefined) {
      const tags = candidate.tags;
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
        return { ok: false, reason: '技能 tags 必须是字符串数组（可省略）' };
      }
    }
    return { ok: true };
  }

  /**
   * 评估契约：技能资产的门禁基准（莫尔/涌现能量，与 ring ④ 门禁同一把尺）。
   * @param _ctx 评估上下文（本类型不改变度量；实参名以 `_` 前缀标注「有意不用」）
   * @returns 资产级基准函数（非技能资产恒 0——fail-closed，绝不「评估不了就给个中间分」）
   */
  public evalContract(_ctx: EvalContext): AssetBenchmark {
    return (asset: unknown): number => {
      const verdict = this.validate(asset);
      if (!verdict.ok) return 0;
      return SkillSchema.benchmarkOf(asset as Skill);
    };
  }

  /**
   * 技能门禁打分（纯函数，单一实现点：CRISPR 差异测试与门禁默认基准都走这里）。
   * @param skill 技能
   * @returns 莫尔/涌现能量（0..1）
   */
  public static benchmarkOf(skill: Skill): number {
    return Benchmark.moireEnergy(skill, SKILL_FIELD_SIZE);
  }
}
