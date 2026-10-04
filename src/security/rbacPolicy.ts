/**
 * RBAC-lite 策略引擎（商业化路线图 **F3** 的实现）。
 *
 * ## 设计取向：**用仓库自己的分类，而不是另立一张工具表**
 *
 * "哪些工具是写类"仓库早有唯一出处：`MUTATING_TOOL_NAMES`（会落盘/改事件流/持久化记忆/能跑任意命令）。
 * 所以角色不是靠"我列一遍工具名"，而是靠**规则**：
 *
 * | 角色 | 允许 | 额外拒绝 |
 * | --- | --- | --- |
 * | `viewer` | 工具清单中**非写类**的全部（自动覆盖将来新增的只读工具） | 治理类（见下） |
 * | `editor` | 除治理类之外的全部（写类仍要过**审批**那道门） | 治理类 |
 * | `admin` | 显式 `*` | 无 |
 *
 * **不写死工具清单**的代价是"新只读工具自动可用"，收益也在同一处——这正是本仓对
 * 「扩展接缝改一处漏一处」的一贯处理（见 `toolNames.ts` 的文件头）。
 *
 * ## 三条 fail-closed（都有判据）
 *
 * 1. **未知角色 ⇒ 全拒**（不是退回默认角色：配置写错字不得变成静默提权）；
 * 2. **未登记工具 ⇒ 全拒**（判断不了它是不是写类时，默认不许；`admin` 的 `*` 是**显式**声明，不算默认放行）；
 * 3. **拒绝即带原因**：点名角色、工具与缺什么（`viewer` 调 `write_file` ⇒ 明说"该角色无写权限"）。
 *
 * ## 治理类工具（跨角色 admin-only）
 *
 * `rollback`（还原工作区 + 截断事件流）与 `checkpoint`（落盘含文件内容的快照）改的是**治理状态本身**，
 * 属"所有者行为"：`viewer`/`editor` 一律拒，`admin` 放行。这条清单**显式**给出并附理由，
 * 不放任"顺手把新工具加进 admin-only"——加一个就要在判据里同步一条。
 *
 * @maturity L1 — 三角色矩阵 / 未知角色与未登记工具 fail-closed / 拒绝优先 / 原因可读 判据钉死
 * @maturityEvidence tests/unit/rbacPolicy.test.ts
 */
import { MUTATING_TOOL_NAMES, TOOL_NAMES } from '../ports/tool/toolNames.js';
import type { ToolCall } from '../ports/tool/tool.js';
import type { RoleDecision, RoleName, RolePolicyPort } from '../ports/security/rolePolicy.js';

/** 角色规格（可被配置覆盖/扩展）。 */
export interface RoleSpec {
  /** 允许的工具模式（支持尾部 `*` 通配；`['*']` = 全部）。 */
  readonly allow: readonly string[];
  /** 拒绝的工具模式（**优先级高于** `allow`）。 */
  readonly deny?: readonly string[] | undefined;
  /** 是否允许写类工具（false ⇒ 写类一律拒，即使 `allow` 命中）。 */
  readonly mutating?: boolean | undefined;
}

/** 策略装配项。 */
export interface RbacPolicyOptions {
  /**
   * 工具清单（用于判定"是否已登记"与"哪些是写类"）。
   * 缺省取 `TOOL_NAMES` 的全部登记项——**不读**运行时端口（策略不得依赖运行时状态）。
   */
  readonly toolCatalog?: readonly string[] | undefined;
  /** 角色表覆盖（缺省内建三角色；给出即**整体替换**，避免"半覆盖"产生难以推理的混合语义）。 */
  readonly roles?: Readonly<Record<RoleName, RoleSpec>> | undefined;
}

/** 跨角色 admin-only 的**治理类**工具（改的是治理状态本身；每条都附理由）。 */
const GOVERNANCE_TOOLS: readonly string[] = [
  // 还原工作区文件 + 截断事件流：属"所有者行为"，普通角色不得执行。
  TOOL_NAMES.rollback,
  // 落盘检查点快照（含工作区文件内容）：同上。
  TOOL_NAMES.checkpoint,
];

/** 内建角色表（可在装配时整体替换）。 */
const DEFAULT_ROLES: Readonly<Record<RoleName, RoleSpec>> = {
  viewer: { allow: ['*'], deny: GOVERNANCE_TOOLS, mutating: false },
  editor: { allow: ['*'], deny: GOVERNANCE_TOOLS, mutating: true },
  admin: { allow: ['*'] },
};

/** RBAC-lite 策略引擎。 */
export class RbacPolicy implements RolePolicyPort {
  /** 已登记工具集合。 */
  private readonly catalog: ReadonlySet<string>;
  /**
   * 写类工具集合（取自 `MUTATING_TOOL_NAMES`；**不另立一张表**——那是仓库对"写类"的唯一出处）。
   *
   * 存成 `ReadonlySet<string>` 而不是直接用原集合：原集合的元素类型是 `ToolName` 字面量联合，
   * 而工具调用传来的是 `string`（工具名可能来自远端/插件）。转一次比到处 `as` 干净。
   */
  private readonly mutating: ReadonlySet<string>;
  /** 角色表。 */
  private readonly roles: Readonly<Record<RoleName, RoleSpec>>;

  /**
   * @param opts 工具清单与角色表覆盖（缺省取内建三角色）
   */
  public constructor(opts: RbacPolicyOptions = {}) {
    this.catalog = new Set(opts.toolCatalog ?? Object.values(TOOL_NAMES));
    this.mutating = new Set<string>(MUTATING_TOOL_NAMES);
    this.roles = opts.roles ?? DEFAULT_ROLES;
  }

  /**
   * 裁决某角色能否调用某工具（fail-closed）。
   * @param role 角色名
   * @param call 待裁决的工具调用
   * @returns 放行或带原因的拒绝
   */
  public decide(role: RoleName, call: ToolCall): RoleDecision {
    const spec = this.roles[role];
    if (spec === undefined) {
      return {
        allow: false,
        reason: `RBAC：未知角色 "${role}"（可用角色：${Object.keys(this.roles).join(' / ')}）`,
      };
    }
    if (!this.catalog.has(call.name)) {
      return {
        allow: false,
        reason: `RBAC：工具 "${call.name}" 未登记（角色 ${role} 不得调用未登记工具——先登记再授权）`,
      };
    }
    // 拒绝优先：治理类与显式 deny 先判，避免"allow: ['*'] 顺手放行"。
    if (RbacPolicy.matchesAny(spec.deny ?? [], call.name)) {
      return {
        allow: false,
        reason: `RBAC：角色 ${role} 无权调用治理类工具 "${call.name}"（仅 admin 可执行：它改的是治理状态本身）`,
      };
    }
    if (spec.mutating === false && this.mutating.has(call.name)) {
      return {
        allow: false,
        reason: `RBAC：角色 ${role} 无写权限（"${call.name}" 属写类工具：会落盘/改事件流/持久化记忆）`,
      };
    }
    if (!RbacPolicy.matchesAny(spec.allow, call.name)) {
      return {
        allow: false,
        reason: `RBAC：角色 ${role} 的允许清单不含 "${call.name}"（允许：${spec.allow.join(', ')}）`,
      };
    }
    return { allow: true };
  }

  /**
   * 角色能力摘要（供 CLI / 治理台展示）。
   * @param role 角色名
   * @returns 允许与拒绝的模式列表；未知角色为空
   */
  public describe(role: RoleName): {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  } {
    const spec = this.roles[role];
    if (spec === undefined) return { allow: [], deny: [] };
    const deny = [...(spec.deny ?? [])];
    if (spec.mutating === false) deny.push(...[...this.mutating].sort());
    return { allow: [...spec.allow], deny: [...new Set(deny)].sort() };
  }

  /**
   * 模式匹配（精确名或尾部 `*` 通配）。
   *
   * **只支持尾部通配**是有意的：`*foo` / `a*b` 这类中缀通配极难推理（安全策略里更容易被绕过），
   * 而"前缀 + 通配"覆盖了真实需求（如 `mcp__*`）。
   * @param patterns 模式列表
   * @param name 工具名
   * @returns 是否命中任一模式
   */
  private static matchesAny(patterns: readonly string[], name: string): boolean {
    for (const pattern of patterns) {
      if (pattern === '*') return true;
      if (pattern.endsWith('*')) {
        if (name.startsWith(pattern.slice(0, -1))) return true;
        continue;
      }
      if (pattern === name) return true;
    }
    return false;
  }
}
