/**
 * 统一资产注册表（ADR-0009 · EVOLVIX_SPEC §3 的 L1 实现，**绞杀者第一态**）。
 *
 * ## 第一态是什么意思
 *
 * 本类**内部持有既有的 `SkillRegistry`**，`SkillPort` 全量成员（register/replace/list/get/match/
 * composeByTwist）一律**委托**给它，一个字节的实现都不复制——所以「技能这条路径」的行为**逐位等价**
 * 是结构决定的，而不是靠小心翼翼地对齐。生产注入路径（`SessionInjector`：
 * `rankForPrompt → SkillSparsifier → render`）本波**不做切换**：注册表先「并存可用 + 判据证明等价」，
 * 切换属绞杀者第二态（本波不做，见 ADR-0009 决策 3）。
 *
 * ## 多出来的那一层是什么
 *
 * 资产实例（`CapabilityRecord`）= 本体 + 溯源 + 适应度 + 治理状态。技能本体仍住在 `SkillRegistry` 里
 * （单一状态源），记录表只附加**治理与溯源**，两者按名字对齐：
 * - `put(record)` 入册（先过 `schemaKind` 的 `validate`，未注册类型即拒 —— J7）；
 * - `recordOf(name)` / `recordsOfKind(kind)` 读记录（前者对技能名回落：技能存在但无记录时按
 *   `SkillSchema` 的默认档**惰性合成**一条，避免「注册路径与记录路径两条真相」）；
 * - `setGovernance(name, patch)` 改治理状态——**必须留台账**，档位只允许收紧。
 *
 * ## 确定性
 *
 * 记录表按插入序保存（`Map`），`recordsOfKind` 按注册序返回；所有判据同输入恒同输出。
 *
 * @maturity L1 — 绞杀者等价（J6，逐位对照 + 变异自证）与注册口/治理 fail-closed 判据钉死
 * @maturityEvidence tests/unit/capabilityRegistry.test.ts
 */
import type { PromotionLedgerPort } from '../ports/runtime/evolution.js';
import type { MoireMeta } from '../ports/skill/moireMeta.js';
import type { MoireOptions } from '../ports/skill/moireOptions.js';
import type { Skill } from '../ports/skill/skill.js';
import type {
  CapabilityRecord,
  CapabilitySchemaRegistryPort,
  CapabilityRegistryPort,
  GovernancePatch,
} from '../ports/capability.js';
import { ISOLATION_LEVEL_ORDER, TRUST_TIER_ORDER } from '../ports/capability.js';
import type { SkillRetrieveHit } from '../skill/skillRetriever.js';
import { SkillRegistry } from '../skill/skillRegistry.js';

/** 注册表装配项。 */
export interface CapabilityRegistryOptions {
  /** 类型注册表（`put` 的校验与默认档来源；必填，无它则「未注册类型即拒」无从谈起）。 */
  readonly schemas: CapabilitySchemaRegistryPort;
  /** 内部技能注册表（缺省新建；传入 = 与既有状态源共用同一份技能表）。 */
  readonly skills?: SkillRegistry | undefined;
  /** 晋升台账（治理变更留账；**缺省 = 治理变更一律拒绝**——无账不生效）。 */
  readonly ledger?: PromotionLedgerPort | undefined;
}

/** 统一资产注册表：`SkillPort` 超集 + 资产实例与治理面。 */
export class CapabilityRegistry implements CapabilityRegistryPort {
  /** 类型注册表（校验与默认档的唯一来源）。 */
  private readonly schemas: CapabilitySchemaRegistryPort;
  /** 内部技能注册表（技能本体的单一状态源）。 */
  private readonly skills: SkillRegistry;
  /** 晋升台账（治理变更入链；undefined = 无账，治理变更被拒）。 */
  private readonly ledger?: PromotionLedgerPort | undefined;
  /** 资产记录（名字 → 记录；插入序）。 */
  private readonly records = new Map<string, CapabilityRecord>();

  /**
   * @param opts 类型注册表 / 内部技能注册表 / 晋升台账
   */
  public constructor(opts: CapabilityRegistryOptions) {
    this.schemas = opts.schemas;
    this.skills = opts.skills ?? new SkillRegistry();
    this.ledger = opts.ledger;
  }

  // ---- SkillPort 全量：一律委托内部 SkillRegistry（第一态的等价性由结构保证） ----

  /**
   * 注册技能；重名即抛错（透传内部注册表）。
   * @param skill 技能
   * @returns 无返回值（void）
   */
  public register(skill: Skill): void {
    this.skills.register(skill);
  }

  /**
   * 原地替换既有技能（透传）。
   * @param skill 技能
   * @returns 无返回值（void）
   */
  public replace(skill: Skill): void {
    this.skills.replace(skill);
  }

  /**
   * 按名移除技能（透传；同时丢弃对应记录——资产已不在表内，记录不该继续可见）。
   * @param name 技能名
   * @returns 存在且已移除为 true
   */
  public remove(name: string): boolean {
    this.records.delete(name);
    return this.skills.remove(name);
  }

  /**
   * 全部技能（透传：顺序即内部注册表的插入序）。
   * @returns 技能列表
   */
  public list(): readonly Skill[] {
    return this.skills.list();
  }

  /**
   * 按名取技能（透传）。
   * @param name 技能名
   * @returns 技能或 undefined
   */
  public get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 字面匹配（透传）。
   * @param text 提示文本
   * @returns 字面命中的技能
   */
  public match(text: string): readonly Skill[] {
    return this.skills.match(text);
  }

  /**
   * 莫尔转角组合（透传：组合产物仍由内部注册表自动注册——行为逐位不变）。
   * @param a 技能 a
   * @param b 技能 b
   * @param opts 莫尔选项
   * @returns 组合技能（含涌现元数据）
   */
  public composeByTwist(a: Skill, b: Skill, opts?: MoireOptions): Skill & { moire: MoireMeta } {
    return this.skills.composeByTwist(a, b, opts);
  }

  // ---- 注入路径的选择面（透传：J6 判据对照的就是这三条） ----

  /**
   * 相关性截断选择（透传）。
   * @param text 提示文本
   * @returns 按相关性降序、已过滤并截断的技能列表
   */
  public selectForPrompt(text: string): readonly Skill[] {
    return this.skills.selectForPrompt(text);
  }

  /**
   * 比率过滤后的完整相关性排名（透传；生产注入路径的第一段）。
   * @param text 提示文本
   * @returns 降序命中（含分）
   */
  public rankForPrompt(text: string): readonly SkillRetrieveHit[] {
    return this.skills.rankForPrompt(text);
  }

  /**
   * 渲染技能指令（透传：注入上下文的那段文本必须逐字相同）。
   * @param skill 技能
   * @returns 渲染文本
   */
  public render(skill: Skill): string {
    return this.skills.render(skill);
  }

  // ---- 资产面：记录 + 治理 ----

  /**
   * 入册一条资产实例（先过所属类型的 `validate`；未注册类型即拒）。
   *
   * 技能资产的**本体**同时进内部技能表（缺则注册，已在则保持原样——记录只是附加治理信息，
   * 不该覆盖一份已在用的技能本体）。
   * @param record 资产实例
   * @returns 无返回值（void）
   * @throws 类型未注册 / 校验不通过 / 记录重复 / 缺名称时抛错（fail-closed）
   */
  public put(record: CapabilityRecord): void {
    const schema = this.schemas.schemaOf(record.schemaKind);
    const verdict = schema.validate(record.asset);
    if (!verdict.ok) {
      throw new Error(`资产校验不通过（${record.schemaKind}）：${verdict.reason}`);
    }
    const name = CapabilityRegistry.nameOf(record.asset);
    if (this.records.has(name)) {
      throw new Error(`资产重复入册: ${name}`);
    }
    if (record.schemaKind === 'skill' && this.skills.get(name) === undefined) {
      this.skills.register(record.asset as Skill);
    }
    this.records.set(name, record);
  }

  /**
   * 取资产实例；技能存在但尚无记录、且**已注册 skill 类型**时按类型默认档惰性合成一条
   * （避免「技能表与记录表两条真相」；类型未注册时不冒充协议内资产，返回 undefined）。
   * @param name 资产名
   * @returns 资产实例或 undefined
   */
  public recordOf(name: string): CapabilityRecord | undefined {
    const existing = this.records.get(name);
    if (existing !== undefined) return existing;
    const skill = this.skills.get(name);
    if (skill === undefined || !this.schemas.has('skill')) return undefined;
    const schema = this.schemas.schemaOf('skill');
    return {
      asset: skill,
      schemaKind: 'skill',
      lineage: { parents: [], operator: 'registry:legacy', bornAt: '' },
      fitness: undefined,
      governance: {
        trustTier: schema.defaultTrustTier,
        isolation: schema.defaultIsolation,
        state: 'active',
        ledgerSeq: undefined,
      },
    };
  }

  /**
   * 按类型列举记录（注册序 = 确定性）。
   * @param kind 类型键
   * @returns 该类型的记录列表
   */
  public recordsOfKind(kind: string): readonly CapabilityRecord[] {
    const out: CapabilityRecord[] = [];
    for (const record of this.records.values()) {
      if (record.schemaKind === kind) out.push(record);
    }
    return out;
  }

  /**
   * 改治理状态：档位只可收紧 + **必须留台账**（无账即拒，绝不静默改状态）。
   * @param name 资产名
   * @param patch 治理补丁
   * @returns 变更后的资产实例
   * @throws 资产不存在 / 无台账 / 档位放宽时抛错（fail-closed）
   */
  public setGovernance(name: string, patch: GovernancePatch): CapabilityRecord {
    const current = this.recordOf(name);
    if (current === undefined) {
      throw new Error(`资产不存在: ${name}`);
    }
    const next = CapabilityRegistry.applyPatch(current, patch);
    if (this.ledger === undefined) {
      throw new Error(`治理变更被拒（无台账不生效）: ${name}`);
    }
    const seq = this.ledger.append({
      name,
      source: `governance:${next.governance.trustTier}/${next.governance.isolation}/${next.governance.state}`,
      action: 'governance',
    });
    const updated: CapabilityRecord = {
      ...next,
      governance: { ...next.governance, ledgerSeq: seq },
    };
    this.records.set(name, updated);
    return updated;
  }

  /**
   * 应用治理补丁（只收紧：信任档/隔离档下标只允许增大；状态可自由转移）。
   * @param current 当前记录
   * @param patch 补丁
   * @returns 打补丁后的记录
   * @throws 档位放宽时抛错
   */
  private static applyPatch(current: CapabilityRecord, patch: GovernancePatch): CapabilityRecord {
    const governance = current.governance;
    const trustTier = CapabilityRegistry.tighten(
      '信任档',
      TRUST_TIER_ORDER,
      governance.trustTier,
      patch.trustTier,
    );
    const isolation = CapabilityRegistry.tighten(
      '隔离档',
      ISOLATION_LEVEL_ORDER,
      governance.isolation,
      patch.isolation,
    );
    return {
      ...current,
      governance: {
        trustTier,
        isolation,
        state: patch.state ?? governance.state,
        ledgerSeq: governance.ledgerSeq,
      },
    };
  }

  /**
   * 档位收紧判定（下标只增不减）。
   * @param label 档位名（错误消息用）
   * @param order 档位全序
   * @param current 当前档
   * @param requested 请求档（undefined = 不改）
   * @returns 生效档（未请求则原档）
   * @throws 请求档比当前档更松时抛错
   */
  private static tighten<T extends string>(
    label: string,
    order: readonly T[],
    current: T,
    requested: T | undefined,
  ): T {
    if (requested === undefined) return current;
    if (order.indexOf(requested) < order.indexOf(current)) {
      throw new Error(`${label}只可收紧不可放宽：${current} → ${requested}`);
    }
    return requested;
  }

  /**
   * 取资产名（当前只有技能资产；新类型在自带 schema 时同步扩展此处）。
   * @param asset 资产本体
   * @returns 资产名
   */
  private static nameOf(asset: unknown): string {
    const name = (asset as { readonly name?: unknown }).name;
    if (typeof name !== 'string' || name === '') {
      throw new Error('资产缺少可用名称（name 必须是非空字符串）');
    }
    return name;
  }
}
