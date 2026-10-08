/**
 * 常驻子进程的**事件循环存活性**管理：有在途请求时 `ref()`（保证响应送达前父进程不离场），
 * 空闲时 `unref()`（父进程想走就走）。
 *
 * ## 为什么必须有这一层（实测）
 *
 * 长驻子进程会拖住 Node 的事件循环：空闲句柄若仍被引用，`omniharness exec` 结束却退不出去。
 * 实测（2026-10-07）：unref 之后 Node 在 393ms 内自然退出；而 Python 侧 stdin 收到 EOF 后
 * 自行退出，不留孤儿进程。
 *
 * ## 为什么独立成类
 *
 * `LayaWarmWorker` 的成员数贴着 `scripts/auditStandards.mjs` 的「上帝类」判据（含类文件
 * >25 成员即红）——按本仓惯例**抽出去而不是放宽阈值**。
 *
 * 技术细节：pipe 句柄在运行时具备 `ref` / `unref`，但 TS 的 `Readable` 类型没有声明它们，
 * 故这里用结构化视图（`RefableHandle`）而不是 `any`。
 */
export class LayaProcessLiveness {
  /**
   * 设置子进程（及其 stdout）的引用状态。
   *
   * @param child 子进程句柄（未启动时为 undefined）。
   * @param referenced 需要拖住父进程时为 true。
   * @returns 无返回值。
   */
  public static set(child: { readonly stdout?: unknown } | undefined, referenced: boolean): void {
    for (const handle of [
      LayaProcessLiveness.refable(child),
      LayaProcessLiveness.refable(child?.stdout),
    ]) {
      if (handle === undefined) {
        continue;
      }
      if (referenced) {
        handle.ref?.();
      } else {
        handle.unref?.();
      }
    }
  }

  /**
   * 把任意对象视作可引用句柄（pipe 句柄在运行时具备 `ref` / `unref`）。
   *
   * @param target 目标对象。
   * @returns 句柄视图；目标为空时返回 undefined。
   */
  private static refable(target: unknown): RefableHandle | undefined {
    return target === undefined || target === null ? undefined : (target as RefableHandle);
  }
}

/** 可被引用计数的 stdio 句柄（pipe 实现有 `ref`/`unref`，但 TS 的 `Readable` 类型没有）。 */
interface RefableHandle {
  /** 增加事件循环引用。 */
  ref?: () => void;
  /** 减少事件循环引用。 */
  unref?: () => void;
}
