/**
 * 监督健康信号分类（2026-10-26）。
 *
 * 背景：真实长任务中一次**策略拒绝**（审批/沙箱/监督内核拦截）会被 `recordToolResult`
 * 当作工具失败上报，危险工具一次失败即推进 safe；safe 又拒绝后续写类工具，形成
 * 「拒绝 → 降级 → 更多拒绝」自锁。实测把 3 分钟任务拖成 3 小时循环。
 *
 * 因此：策略拒绝不是工具健康度信号，不参与 supervisor 的失败率统计；真实执行失败
 * （异常、超时、校验失败）仍上报。
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
}
