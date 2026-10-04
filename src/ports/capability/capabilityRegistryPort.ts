/**
 * 统一资产注册表端口（ADR-0009 · EVOLVIX_SPEC §2）：既有 `SkillPort` 的**严格超集**。
 *
 * 超集关系是绞杀者迁移的类型基础：任何只认 `SkillPort` 的调用方都能用本端口；
 * 新增的四个成员把「资产」从技能升格为**受治理状态**：
 *
 * - `put(record)`：入册。**必须**用所属 `schemaKind` 的 `validate` 把关（未注册类型即拒，J7）；
 * - `recordOf(name)`：取资产实例（本体 + 溯源 + 适应度 + 治理状态）；
 * - `recordsOfKind(kind)`：按类型列举（确定性顺序）；
 * - `setGovernance(name, patch)`：改治理状态——**变更必须留台账**，无台账即拒（无账不生效）。
 *
 * 档位纪律：`patch` 只允许把信任档/隔离档**朝更严方向**移动（全序见 `TRUST_TIER_ORDER` /
 * `ISOLATION_LEVEL_ORDER`）；放宽请求抛错而非静默忽略。
 */
import type { SkillPort } from '../runtime/skill.js';
import type { CapabilityRecord } from './capabilityRecord.js';
import type { IsolationLevel } from './isolationLevel.js';
import type { TrustTier } from './trustTier.js';

/** 治理状态补丁（只允许收紧；`state` 可转到任何合法状态）。 */
export interface GovernancePatch {
  /** 目标信任档（只可更严）。 */
  readonly trustTier?: TrustTier | undefined;
  /** 目标隔离档（只可更严）。 */
  readonly isolation?: IsolationLevel | undefined;
  /** 目标生命周期状态。 */
  readonly state?: 'active' | 'frozen' | 'revoked' | undefined;
}

/** 统一资产注册表：`SkillPort` 超集 + 资产实例与治理面。 */
export interface CapabilityRegistryPort extends SkillPort {
  /**
   * 入册一条资产实例。
   * @param record 资产实例（`schemaKind` 必须已注册且在 `validate` 下合法）
   * @returns 无返回值（void）
   * @throws 类型未注册 / 校验不通过 / 名称冲突时抛错（fail-closed，绝不静默收下）
   */
  put(record: CapabilityRecord): void;
  /**
   * 按名移除资产（本体与记录一并移除）。
   *
   * 为什么端口必须声明它：**补偿路径**——批量入册（如签名资产包安装，Wave D）中途失败时要把
   * 本轮已入册的资产撤回去，否则「整包原子」只是口头承诺。移除**不是**回滚的替代品：
   * 回滚走台账 `rollback(seq)`（表级还原），本方法只撤销「尚未入账的写入」。
   * @param name 资产名
   * @returns 存在且已移除为 true（不存在时 false，幂等）
   */
  remove(name: string): boolean;
  /**
   * 取资产实例。
   * @param name 资产名
   * @returns 资产实例；不存在为 undefined
   */
  recordOf(name: string): CapabilityRecord | undefined;
  /**
   * 按类型列举资产实例（**确定性顺序**：注册序）。
   * @param kind 类型键
   * @returns 该类型的资产实例列表
   */
  recordsOfKind(kind: string): readonly CapabilityRecord[];
  /**
   * 改治理状态（**必须留台账**：无台账即拒，档位只可收紧）。
   * @param name 资产名
   * @param patch 治理补丁
   * @returns 变更后的资产实例
   * @throws 资产不存在 / 无台账 / 档位放宽时抛错（fail-closed）
   */
  setGovernance(name: string, patch: GovernancePatch): CapabilityRecord;
}
