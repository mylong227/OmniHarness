/**
 * shell 工具层命令裁决（A3 工具层纵深第二环）。
 *
 * 位置：本策略运行在**工具内部**，独立于上层 `ToolGate`（审批/沙箱）。二者是纵深关系，
 * 不是替代关系——`ToolGate` 决定「这条命令能不能提权执行」，本策略决定「这条命令的**结构**
 * 是否符合工具自身承诺的安全形状」。
 *
 * 两种模式（默认 `audit`，**零行为变更**）：
 * - `audit`：解析并记录违规（`shell.policy.audit` 日志），不阻断——默认值取 audit 是因为
 *   本工具对外契约包含管道/重定向，把默认改成阻断属行为变更，须由 A2 权限档显式驱动；
 * - `enforce`：命中即拒（fail-closed），错误文案带「策略拒绝」前缀便于上层辨识。
 */

import type { ShellCommandPlan } from './shellCommandParser.js';
import { ShellCommandParser } from './shellCommandParser.js';
import { log } from '../../../util/logger.js';

/** 裁决模式。 */
export type ShellPolicyMode = 'audit' | 'enforce';

/** 策略选项。 */
export interface ShellCommandPolicyOptions {
  /** 模式：默认取环境变量 `OMNI_SHELL_POLICY`（`enforce` 为强制，其余一律 audit）。 */
  readonly mode?: ShellPolicyMode;
  /** 命令替换（`$(` / 反引号）是否按违规处理，默认 **true**（把数据变成命令的经典注入构造）。 */
  readonly denySubstitution?: boolean;
  /** 拒绝执行的程序名列表（大小写不敏感，忽略路径与 Windows 扩展名）。 */
  readonly denyPrograms?: readonly string[];
  /** 程序白名单：一旦给出，不在名单内的程序即违规。默认不启用。 */
  readonly allowPrograms?: readonly string[];
}

/** Windows 下可执行扩展名（归一化程序名时剥离）。 */
const WIN_EXEC_EXT = /\.(exe|cmd|bat|com|ps1)$/i;

/**
 * shell 命令策略：解析命令结构并按配置裁决，返回拒绝原因或 `undefined`。
 */
export class ShellCommandPolicy {
  /** 裁决模式。 */
  private readonly mode: ShellPolicyMode;
  /** 命令替换是否按违规处理。 */
  private readonly denySubstitution: boolean;
  /** 拒绝程序集合（已归一化）。 */
  private readonly denyPrograms: ReadonlySet<string>;
  /** 程序白名单（已归一化）；`undefined` 表示不启用。 */
  private readonly allowPrograms: ReadonlySet<string> | undefined;
  /** 命令解析器（本策略只依赖其窄接口）。 */
  private readonly parser = new ShellCommandParser();

  /**
   * @param options 策略选项（模式/替换开关/程序名单，全有安全默认）。
   */
  public constructor(options: ShellCommandPolicyOptions = {}) {
    this.mode = options.mode ?? (process.env.OMNI_SHELL_POLICY === 'enforce' ? 'enforce' : 'audit');
    this.denySubstitution = options.denySubstitution ?? true;
    this.denyPrograms = new Set((options.denyPrograms ?? []).map((p) => this.normalize(p)));
    this.allowPrograms =
      options.allowPrograms === undefined
        ? undefined
        : new Set(options.allowPrograms.map((p) => this.normalize(p)));
  }

  /**
   * 裁决一条命令。
   *
   * @param command 已 trim 的命令文本。
   * @returns 拒绝说明（enforce 命中）；否则 `undefined`（含 audit 模式的一切情形）。
   */
  public decide(command: string): string | undefined {
    const outcome = this.parser.parse(command);
    if (!outcome.ok) {
      return this.violation(`命令无法结构化解析：${outcome.reason}`);
    }
    return this.judge(command, outcome.plan);
  }

  /**
   * 按结构化计划逐条判定违规。
   *
   * @param command 原始命令（审计日志用）。
   * @param plan 结构化计划。
   * @returns 拒绝说明或 `undefined`。
   */
  private judge(command: string, plan: ShellCommandPlan): string | undefined {
    if (this.denySubstitution && plan.hasSubstitution) {
      return this.violation('命令替换（`$(` 或反引号）已被工具层策略禁用');
    }
    for (const program of plan.programs) {
      const name = this.normalize(program);
      if (this.denyPrograms.has(name)) {
        return this.violation(`程序 \`${program}\` 在拒绝名单中`);
      }
      if (this.allowPrograms !== undefined && !this.allowPrograms.has(name)) {
        return this.violation(`程序 \`${program}\` 不在白名单中`);
      }
    }
    this.audit(command, plan);
    return undefined;
  }

  /**
   * 违规处理：enforce 返回拒绝说明；audit 只记录日志。
   *
   * @param reason 违规原因（面向模型的中文说明）。
   * @returns enforce 模式下带前缀的拒绝说明；audit 模式下 `undefined`。
   */
  private violation(reason: string): string | undefined {
    if (this.mode === 'enforce') {
      return `命令被工具层策略拒绝：${reason}`;
    }
    log.warn('shell.policy.audit', { reason });
    return undefined;
  }

  /**
   * 审计记录（audit 模式与 enforce 放行路径共用，保证放行命令也有结构化痕迹）。
   *
   * @param command 原始命令。
   * @param plan 结构化计划。
   * @returns 无返回值。
   */
  private audit(command: string, plan: ShellCommandPlan): void {
    if (!plan.hasRedirection && !plan.hasChaining && plan.segments.length === 1) {
      return;
    }
    log.debug('shell.policy.plan', {
      programs: plan.programs,
      segments: plan.segments.length,
      redirection: plan.hasRedirection,
      chaining: plan.hasChaining,
      commandLength: command.length,
    });
  }

  /**
   * 归一化程序名：取路径末段、去 Windows 可执行扩展名、转小写。
   *
   * @param program 程序名或路径。
   * @returns 归一化名称。
   */
  private normalize(program: string): string {
    const parts = program.split(/[\\/]/);
    const base = parts[parts.length - 1] ?? program;
    return base.replace(WIN_EXEC_EXT, '').toLowerCase();
  }
}
