/**
 * 监督健康信号分类（2026-10-26，2026-10-27 扩一类）。
 *
 * 背景：真实长任务中一次**策略拒绝**（审批/沙箱/监督内核拦截）会被 `recordToolResult`
 * 当作工具失败上报，危险工具一次失败即推进 safe；safe 又拒绝后续写类工具，形成
 * 「拒绝 → 降级 → 更多拒绝」自锁。实测把 3 分钟任务拖成 3 小时循环。
 *
 * 因此：策略拒绝不是工具健康度信号，不参与 supervisor 的失败率统计；真实执行失败
 * （异常、超时、校验失败）仍上报。
 *
 * 2026-10-27 追加（真模型 m1/m2 暴露的同类第二坑）：`shell` 的**非零退出码**也被当成
 * 工具失败 ⇒ 模型跑了自己刚写的红测试（`exit 1`，本就是要修的中间态）就立刻推进 safe，
 * 之后 shell/write_file/subagent 全被否，模型只能空转 `tool_search`。判据见
 * `tests/unit/supervisorCommandOutcome.test.ts`。判别依据是 `ToolResult.exitCode`
 * （**真实退出码**，不是错误文案）——「命令跑完了」与「工具坏了」必须分开。
 */
export class SupervisorHealthSignal {
  /** 策略拒绝的特征（中英；大小写不敏感）。 */
  private static readonly DENIAL_PATTERNS: readonly RegExp[] = [
    /监督内核\((?:safe|locked)\)/iu,
    /审批(?:拒绝|未通过)/u,
    /沙箱(?:拒绝|拦截)/u,
    /\b(?:approval|denied|permission|sandbox|policy)\b/iu,
    /\bEPERM\b/u,
  ];

  /**
   * 判断错误文本是否是策略拒绝（而非真实执行失败）。
   * @param error 工具错误文本。
   * @returns 策略拒绝为 true。
   */
  public static isPolicyDenial(error: string | undefined): boolean {
    if (error === undefined || error === '') return false;
    return SupervisorHealthSignal.DENIAL_PATTERNS.some((pattern) => pattern.test(error));
  }

  /**
   * 判断一次失败是否是「命令已执行完但返回非零」——这是**命令结果**，不是工具健康失败。
   *
   * 只认工具填写的**真实退出码**（`ToolResult.exitCode`），不解析错误文案：文案会漂，
   * 而「子进程确实退出过」是硬事实。超时 / 信号终止 / 进程起不来时工具不填该字段，
   * 因而仍被计为真实失败（fail-closed 不放宽）。
   * @param result 工具结果中最小的判定面（`ok` + 可选 `exitCode`）。
   * @returns 执行完且非零退出为 true。
   */
  public static isCommandOutcome(result: {
    readonly ok: boolean;
    readonly exitCode?: number | undefined;
  }): boolean {
    return !result.ok && result.exitCode !== undefined && result.exitCode !== 0;
  }
}
