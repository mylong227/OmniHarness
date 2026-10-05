/**
 * 资产协议装配器（Wave B · ADR-0009）：把 L1 资产层接进组合根。
 *
 * ## 装配内容
 *
 * `capability.enabled === true` 时构造三件（缺省关 ⇒ 整个切片 undefined，零行为变更）：
 * 1. **类型注册表**：注册内置类型 `skill` 与 `workflow-template`（新类型只需再加一行）；
 * 2. **统一资产注册表**：内部持**同一份** `SkillRegistry`（绞杀者第一态的实质——
 *    不是复制一份技能表，而是给同一张表加治理面）；
 * 3. **通用评估器**：按类型声明的度量出判据（不写适应度，写入由调用方决定）。
 *
 * ## 档位下限怎么落地
 *
 * `capability.isolationDefaults` 是**下限**：装配时把它与各类型 schema 的默认档取**更严者**，
 * 并把结果写进 `defaults` 供注册表在建记录时使用。这样「配置写了更严的档」一定生效，
 * 而「配置想放松某类型的默认档」不会——放宽只能走 `setGovernance` 的显式路径，
 * 且那条路径本身也受「只收紧」判据约束（ADR-0009 决策 6）。
 *
 * @maturity L1 — 装配面判据钉死（关时零切片 / 开时三件齐 + 档位下限只收紧）
 * @maturityEvidence tests/unit/capabilityAssembly.test.ts
 */
import { CapabilityEvaluator } from '../capability/capabilityEvaluator.js';
import { CapabilityRegistry } from '../capability/capabilityRegistry.js';
import { CapabilitySchemaRegistry } from '../capability/capabilitySchemaRegistry.js';
import { SkillSchema } from '../capability/schemas/skillSchema.js';
import { WorkflowTemplateSchema } from '../capability/schemas/workflowTemplateSchema.js';
import { WasmSkillSchema } from '../capability/schemas/wasmSkillSchema.js';
import { ISOLATION_LEVEL_ORDER, TRUST_TIER_ORDER } from '../ports/capability.js';
import type { IsolationLevel, TrustTier } from '../ports/capability.js';
import type { CapabilityConfig } from '../ports/config/capabilityConfig.js';
import type { CapabilityStack } from '../ports/config/capabilityStack.js';
import type { SkillRegistry } from '../skill/skillRegistry.js';

export type { CapabilityStack };

/** 装配选项。 */
export interface CapabilityStackOptions {
  /** 已装配的技能注册表（**同一份**，不复制）。 */
  readonly skillRegistry: SkillRegistry;
  /** 配置段（缺省 = 不装配）。 */
  readonly config?: CapabilityConfig | undefined;
}

/** 资产协议装配器（纯静态，无状态）。 */
export class CapabilityStackAssembler {
  private constructor() {}

  /**
   * 装配资产协议切片。
   * @param opts 技能注册表与配置段
   * @returns 切片；`enabled !== true` 时为 undefined（零行为变更）
   */
  public static assemble(opts: CapabilityStackOptions): CapabilityStack | undefined {
    if (opts.config?.enabled !== true) return undefined;
    const schemas = new CapabilitySchemaRegistry();
    schemas.register(new SkillSchema());
    schemas.register(new WorkflowTemplateSchema());
    // (Wave C) wasm 技能：进化产物的 wasm 载体（默认 evolved + wasm 档）。
    schemas.register(new WasmSkillSchema());
    const registry = new CapabilityRegistry({ schemas, skills: opts.skillRegistry });
    const evaluator = new CapabilityEvaluator({ schemas });
    return {
      schemas,
      registry,
      evaluator,
      defaults: CapabilityStackAssembler.resolveDefaults(opts.config),
    };
  }

  /**
   * 解析档位下限：配置与内置最严默认取更严者（只收紧，绝不放宽）。
   * @param config 配置段
   * @returns 生效档位
   */
  private static resolveDefaults(config: CapabilityConfig): {
    readonly trustTier: TrustTier;
    readonly isolation: IsolationLevel;
  } {
    // 内置出厂下限：`evolved` + `vm`（签名/进化产物按最严起步；`core` 类型仍可用自身 schema 的
    // 更松默认档——因为「下限」只用于新建未知来源资产，见类文档）。
    const configuredTrust = config.isolationDefaults?.trustTier;
    const configuredIsolation = config.isolationDefaults?.isolation;
    return {
      trustTier: CapabilityStackAssembler.stricter(TRUST_TIER_ORDER, 'evolved', configuredTrust),
      isolation: CapabilityStackAssembler.stricter(
        ISOLATION_LEVEL_ORDER,
        'vm',
        configuredIsolation,
      ),
    };
  }

  /**
   * 取两档中更严者。
   * @param order 档位全序
   * @param fallback 出厂下限
   * @param requested 配置值（可缺省）
   * @returns 生效档
   */
  private static stricter<T extends string>(
    order: readonly T[],
    fallback: T,
    requested: T | undefined,
  ): T {
    if (requested === undefined) return fallback;
    return order.indexOf(requested) > order.indexOf(fallback) ? requested : fallback;
  }
}
