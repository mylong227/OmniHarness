/**
 * 技能包分级器（商业化路线图 **H1**：「静态权限扫描 + 沙箱运行 + 差异测试 ⇒ A/B/C 评级
 * ——**评级即门禁输出，不是人工标签**」）。
 *
 * ## 三条腿与各自能证明什么
 *
 * | 腿 | 输入 | 能证明 | **不能**证明 |
 * | --- | --- | --- | --- |
 * | ① 静态权限扫描 | 包内文件文本 | 出现了哪些危险**能力证据**（起进程/写文件/出网/动态求值/读环境/包外路径/原生扩展） | 运行时是否会真的用到（词法扫描可被混淆绕过） |
 * | ② 沙箱运行 | 注入的 `IsolationPort` | 声明的入口在**受限环境**里能否跑通、是否越界 | 沙箱实现本身的完备性 |
 * | ③ 差异测试 | 声明权限 ⊖ 扫描到的实际能力 | **未声明**的能力（市场场景最贵的一类风险） | 语义等价性 |
 *
 * ## 评级规则（**唯一出处**，且只降不升）
 *
 * - **C**：`critical` 发现（动态求值 / 原生扩展）**或**存在未声明的能力 **或**沙箱未跑通
 *   ⇒ 不可安装（`installable:false`）。
 * - **B**：所有能力都已声明，但其中含 `high`（起进程 / 写文件 / 出网）⇒ 可安装，但市场标注
 *   "需声明授权"，且默认走受限档运行。
 * - **A**：无 `high`/`critical` 证据（只剩 `medium` 或全无），且沙箱跑通、声明与实做一致
 *   ⇒ 可安装，正常档。
 *
 * 三条**不对称**（本模块的核心性质）：
 * 1. 扫不到 ⇒ **不升级**（缺证据只是"没扫出"，故 A 需要"沙箱跑通 + 声明一致"共同支撑）；
 * 2. 声明多写了但实际没用到 ⇒ **不降级**（多声明是保守，不是风险）；
 * 3. 任何一腿**异常/缺件** ⇒ 按 C 处理（fail-closed：判据坏掉不等于放行）。
 *
 * @maturity L1 — A/B/C 三档可达 / 未声明能力一票 C / 沙箱失败一票 C / 缺腿 fail-closed / 确定性 判据钉死
 * @maturityEvidence tests/unit/packGrader.test.ts
 */
import { log } from '../util/logger.js';
import { PackStaticScanner } from './packStaticScanner.js';
import type { PackCapability, PackFinding, PackScanReport } from './packStaticScanner.js';

/** 评级拒因的**可机读码**（§12.1-4）。 */
export type PackGradeCode =
  | 'sandbox-failed'
  | 'verification-incomplete'
  | 'undeclared-capability'
  | 'critical-evidence'
  | 'declared-high-risk'
  | 'clean';

/** 观测回调（缺省写共享 logger）。 */
export type PackGradeObserver = (event: string, fields: Record<string, unknown>) => void;

/** 评级（市场展示用；`A` 最高）。 */
export type PackRating = 'A' | 'B' | 'C';

/** 沙箱腿结论（由调用方按注入的 `IsolationPort` 产出，本模块只消费结论）。 */
export interface SandboxLegVerdict {
  /** 声明入口是否在受限环境里跑通。 */
  readonly ran: boolean;
  /** 判定层级（如 `in-process` / `os-sandbox`）；缺省表示未执行。 */
  readonly level?: string | undefined;
  /** 实际执行的入口（包内相对路径）。**必须报出来**，否则"跑通了哪个文件"无从复核。 */
  readonly entry?: string | undefined;
  /**
   * 是否处于**最小权限模式**：沙箱刻意不提供 `require` 等宿主能力（正确的默认），
   * 于是"声明了起进程/出网"的包**必然**在动态验证阶段失败——这不是包的缺陷，而是**验证能力边界**。
   *
   * 语义：`ran:false && minimalAuthority:true` ⇒ 动态验证**不完整**（既非通过、也非包的问题），
   * 评级**封顶 B**（受限运行），绝不放行到 A。
   */
  readonly minimalAuthority?: boolean | undefined;
  /** 失败原因（`ran:false` 时给出，必须可读）。 */
  readonly reason?: string | undefined;
}

/** 分级输入。 */
export interface PackGradeInput {
  /** 包内文件（相对路径 → 文本）。 */
  readonly files: ReadonlyMap<string, string>;
  /** 包**声明**的能力（清单里的 permissions；缺省 = 未声明任何能力）。 */
  readonly declared: readonly PackCapability[];
  /** 沙箱腿结论（缺省 ⇒ 视为未跑通，进而 C——fail-closed）。 */
  readonly sandbox: SandboxLegVerdict;
  /** 观测回调（缺省写共享 logger）。 */
  readonly observer?: PackGradeObserver | undefined;
}

/** 分级结论（**这就是门禁输出**：市场页/CLI/安装器都读它）。 */
export interface PackGradeReport {
  /** 评级。 */
  readonly rating: PackRating;
  /** 是否允许安装（C ⇒ false）。 */
  readonly installable: boolean;
  /** 三条腿的证据（逐条可复核）。 */
  readonly evidence: {
    readonly scan: {
      readonly scannedFiles: number;
      readonly findings: readonly PackFinding[];
      readonly capabilities: readonly PackCapability[];
    };
    readonly sandbox: SandboxLegVerdict;
    readonly diff: {
      /** 声明了但没扫到（保守，不降级）。 */
      readonly declaredUnused: readonly PackCapability[];
      /** 扫到但没声明（**风险**，一票 C）。 */
      readonly undeclared: readonly PackCapability[];
    };
  };
  /** 降级/否决原因（每档都给得出，供市场页直接展示）。 */
  readonly reasons: readonly string[];
  /** **可机读**评级依据码（与 `reasons` 一一对应，供门禁/告警分流）。 */
  readonly codes: readonly PackGradeCode[];
}

/** 技能包分级器。 */
export class PackGrader {
  private constructor() {}

  /**
   * 给一个包评级（确定性：同输入恒同评级）。
   * @param input 文件 / 声明能力 / 沙箱结论
   * @returns 分级报告
   */
  public static grade(input: PackGradeInput): PackGradeReport {
    const scan = PackStaticScanner.scan(input.files);
    const declared = new Set(input.declared);
    const undeclared = scan.capabilities.filter((capability) => !declared.has(capability));
    // 排序：市场页与审计都读这张表，顺序不稳定会把"两次报告不一样"变成假告警。
    const declaredUnused = [...declared]
      .filter((capability) => !scan.capabilities.includes(capability))
      .sort();
    const evidence: PackGradeReport['evidence'] = PackGrader.evidenceOf(
      scan,
      input.sandbox,
      declaredUnused,
      undeclared,
    );
    const reasons: string[] = [];
    const critical = scan.findings.filter((f) => f.severity === 'critical');
    const high = scan.findings.filter((f) => f.severity === 'high');
    // 最小权限模式下的失败**不是**包的缺陷，而是"我们验不动它"——故不按 C 处理，但**封顶 B**
    // （绝不能因为"验不动"就给 A：那等于把"无法验证"当成"验证通过"）。
    const verificationIncomplete =
      !input.sandbox.ran &&
      input.sandbox.minimalAuthority === true &&
      undeclared.length === 0 &&
      critical.length === 0;

    // **先收集全部问题，再定档**：一条报告只报"第一个错"会让作者改完一个又冒一个
    // （第一版就是短路返回，于是"未声明能力"被"沙箱没跑通"掩盖——两个问题只暴露一个）。
    if (!input.sandbox.ran) {
      // 措辞按**沙箱事实**给（是否最小权限），而不是按最终评级反推：
      // 一个包可以同时"验不动"且"未声明能力"，两个事实都该如实出现
      // （否则运维会以为只差一件事，改完声明却发现还是 C）。
      const label =
        input.sandbox.minimalAuthority === true ? '动态验证不完整（最小权限模式）' : '沙箱未跑通';
      reasons.push(`${label}：${input.sandbox.reason ?? '未提供沙箱结论'}`);
    }
    if (undeclared.length > 0) {
      reasons.push(`存在未声明能力：${undeclared.join(', ')}（声明与实做不一致）`);
    }
    if (critical.length > 0) {
      reasons.push(
        `存在致命能力证据：${[...new Set(critical.map((f) => f.capability))].join(', ')}（静态扫描不可覆盖其行为）`,
      );
    }

    // C：任一致命条件命中（fail-closed：判据坏掉 / 说一套做一套 / 不可验证 都不放行）。
    if (
      (!input.sandbox.ran && !verificationIncomplete) ||
      undeclared.length > 0 ||
      critical.length > 0
    ) {
      const codes: PackGradeCode[] = [];
      if (!input.sandbox.ran && !verificationIncomplete) codes.push('sandbox-failed');
      if (undeclared.length > 0) codes.push('undeclared-capability');
      if (critical.length > 0) codes.push('critical-evidence');
      return PackGrader.finish('C', false, evidence, reasons, codes, input.observer);
    }
    // B：动态验证不完整（最小权限模式）**或**含已声明高危能力 ⇒ 可装但受限运行、封顶 B。
    if (verificationIncomplete || high.length > 0) {
      const codes: PackGradeCode[] = [];
      if (verificationIncomplete) codes.push('verification-incomplete');
      if (high.length > 0) {
        codes.push('declared-high-risk');
        reasons.push(
          `已声明的高危能力：${[...new Set(high.map((f) => f.capability))].join(', ')}（需声明授权，默认受限运行）`,
        );
      }
      return PackGrader.finish('B', true, evidence, reasons, codes, input.observer);
    }
    // A：扫不到高危 + 沙箱跑通 + 声明一致（三条缺一不可）。
    reasons.push(
      scan.findings.length === 0
        ? '未扫出危险能力证据，沙箱跑通，声明与实做一致'
        : `仅有中危证据（${[...new Set(scan.findings.map((f) => f.capability))].join(', ')}），沙箱跑通，声明与实做一致`,
    );
    if (declaredUnused.length > 0) {
      reasons.push(`声明了但未扫到（保守声明，不影响评级）：${declaredUnused.join(', ')}`);
    }
    return PackGrader.finish('A', true, evidence, reasons, ['clean'], input.observer);
  }

  /**
   * 装配"三条腿"证据（纯装配，不做判断）。
   *
   * 抽出来的理由：`grade` 的分级逻辑本身就是一屏（四个出口），再把证据装配夹在中间，
   * 读的人要在"组装数据"和"定档"之间来回切换——函数体铁律（≤80 行）在这里是**信号**而非障碍。
   * @param scan 静态扫描结论
   * @param sandbox 沙箱腿结论
   * @param declaredUnused 声明了但未扫到的能力
   * @param undeclared 扫到但未声明的能力
   * @returns 证据块
   */
  private static evidenceOf(
    scan: PackScanReport,
    sandbox: SandboxLegVerdict,
    declaredUnused: readonly PackCapability[],
    undeclared: readonly PackCapability[],
  ): PackGradeReport['evidence'] {
    return {
      scan: {
        scannedFiles: scan.scannedFiles,
        findings: scan.findings,
        capabilities: scan.capabilities,
      },
      sandbox,
      diff: { declaredUnused, undeclared },
    };
  }

  /**
   * 造分级结论并**在这一处**落结构化事件（§12.1-4：判定与拒绝都要可查）。
   *
   * 集中一处的理由同 RBAC：分级有四个出口，散着写事件必然漏一个——而市场页/安装器
   * 恰恰要按 `codes` 分流（"为什么是 C"不该靠解析中文原因）。
   * @param rating 评级
   * @param installable 是否可安装
   * @param evidence 三条腿证据
   * @param reasons 可读原因
   * @param codes 可机读依据码
   * @param observer 观测回调（缺省写共享 logger）
   * @returns 分级报告
   */
  private static finish(
    rating: PackRating,
    installable: boolean,
    evidence: PackGradeReport['evidence'],
    reasons: readonly string[],
    codes: readonly PackGradeCode[],
    observer: PackGradeObserver | undefined,
  ): PackGradeReport {
    const emit =
      observer ?? ((event: string, fields: Record<string, unknown>) => log.warn(event, fields));
    emit('pack.graded', { rating, installable, codes });
    return { rating, installable, evidence, reasons, codes };
  }
}
