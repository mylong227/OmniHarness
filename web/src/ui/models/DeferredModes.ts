// 会话模式的「暂存 → 会话出现后落盘」协作者（纯逻辑，不碰 React / DOM，可直测）。
//
// ## 为什么需要它（2026-10-06 用户截图报错）
//
// 「目标 / 计划模式 / 绘图」按**会话**持久化，而会话是**惰性创建**的（发第一条消息时 `turns.run` 才建）。
// 用户在还没发过消息时点「+ → 计划模式」，前端把空 threadId 直接发给服务端 ⇒ 界面弹红字
// 「模式切换失败：modes.set 需要 threadId」。服务端拒得没错，错在前端把"还没有归属对象"当成了失败。
//
// 正确语义：**暂存**用户的意图，等会话一出现（`ComposerController.send` 拿到 `res.threadId`）立刻落盘。
//
// 独立性：本类只依赖一个 `modesSet(threadId, patch)` 调用口（构造注入），因此既能被控制器复用，
// 也能在 node 里用桩穷举时序（见 `web/test/pendingModes.test.mjs`）。

import { PendingModes, type SessionModePatch } from './PendingModes.js';

/** 落盘调用口（与 `ApiClient.modesSet` 同形）。 */
export type ModesSetter = (threadId: string, patch: SessionModePatch) => Promise<unknown>;

/**
 * 会话模式的「暂存 → 会话出现后落盘」协作者。
 *
 * 见文件头：会话惰性创建，而模式按会话持久化 ⇒ 建会话前点模式开关只能**暂存**，不能报错。
 */
export class DeferredModes {
  /** 落盘调用口（生产注入 ApiClient.modesSet，测试注入桩）。 */
  private readonly setter: ModesSetter;

  /** 已暂存但尚未落盘的补丁（会话出现后一次写清）。 */
  private pending: SessionModePatch = {};

  /**
   * @param setter 落盘调用口。
   */
  public constructor(setter: ModesSetter) {
    this.setter = setter;
  }

  /**
   * 应用模式补丁：有会话 ⇒ 立刻落盘；没会话 ⇒ 暂存（等 {@link DeferredModes.flush}）。
   * @param threadId 当前会话 id（`null`/空串＝尚未创建）。
   * @param patch 模式补丁。
   * @returns `'applied'` 已落盘；`'deferred'` 已暂存。
   */
  public async apply(
    threadId: string | null | undefined,
    patch: SessionModePatch,
  ): Promise<'applied' | 'deferred'> {
    if (threadId === null || threadId === undefined || threadId === '') {
      this.pending = PendingModes.merge(this.pending, patch);
      return 'deferred';
    }
    await this.setter(threadId, patch);
    this.pending = {};
    return 'applied';
  }

  /**
   * 会话出现后把暂存的补丁落盘（幂等；无暂存或 id 为空时不做任何 RPC）。
   * @param threadId 新会话 id。
   * @returns 异步完成（落盘失败静默：模式是增强，不该影响回合本身）。
   */
  public async flush(threadId: string): Promise<void> {
    // 空 id 一律不发：那是同一类报错的另一个入口。暂存**保留**——丢掉它等于把用户的点击静默吞掉。
    if (threadId === '' || PendingModes.isEmpty(this.pending)) return;
    const patch = this.pending;
    this.pending = {};
    try {
      await this.setter(threadId, patch);
    } catch {
      /* 静默：模式落盘失败不影响回合 */
    }
  }
}
