// 会话模式的补丁语义（纯数据，零 DOM / 零 React，可在 node 里直测）。
//
// ## 为什么需要它（2026-10-06 真机报错）
//
// 用户在**还没创建会话**时点「+ → 计划模式 / 目标」，界面上弹出「模式切换失败：modes.set 需要 threadId」。
// 根因不是服务端苛刻，而是**会话是惰性创建的**（发第一条消息时 `turns.run` 才建会话），而
// 「目标 / 计划模式 / 绘图」都是**按会话持久化**的模式 ⇒ 此时根本没有可写的会话。
//
// 正确的用户意图显然是："我要开始一个带这些模式的会话"。故：**先暂存，等会话一出现就落盘**
// （见 SessionController.applyModes / flushPendingModes）。本文件只负责"补丁怎么合并、是否为空"，
// 让那段时序逻辑无需碰 React 即可单测。

/** 会话模式补丁（与 RPC `modes.set` 的字段一一对应）。 */
export interface SessionModePatch {
  /** 持续目标（空串＝清除）。 */
  readonly goal?: string;
  /** 计划模式（只读规划，写类工具被门禁拦下）。 */
  readonly planMode?: boolean;
  /** 草图模式。 */
  readonly sketchMode?: boolean;
}

/**
 * 模式补丁的合并/空判定（纯静态工具，供 DeferredModes 复用）。
 */
export class PendingModes {
  /**
   * 合并补丁（后者覆盖前者的同名字段；其余字段保留）。
   * @param current 已暂存的补丁。
   * @param patch 新补丁。
   * @returns 合并后的补丁（新对象，不改入参）。
   */
  public static merge(current: SessionModePatch, patch: SessionModePatch): SessionModePatch {
    return { ...current, ...patch };
  }

  /**
   * 补丁是否为空（空则无需落盘，也就无需占用"待应用"状态）。
   * @param patch 补丁。
   * @returns 没有任何字段为 true/非 undefined 时为 true。
   */
  public static isEmpty(patch: SessionModePatch): boolean {
    return (
      patch.goal === undefined && patch.planMode === undefined && patch.sketchMode === undefined
    );
  }

  /**
   * 暂存提示文案（面向用户，说明"现在为什么不生效、什么时候生效"）。
   * @returns 一行中文提示。
   */
  public static deferredHint(): string {
    return '尚未创建会话：该模式已记录，发送第一条消息后自动生效';
  }
}
