// 回合流式缓冲：`StreamThrottle`（纯节流）与"一个回合一个实例"的**生命周期**之间的那一层。
//
// ## 为什么要单独一层
//
// 节流本身（有界频率 / 零丢失 / 可注入时钟）已经在 `StreamThrottle` 里做完了，但"谁在什么时候
// 建、什么时候刷、什么时候丢"属于**回合生命周期**，原先散在 `SessionController` 的三个私有成员里
// （字段 + 惰性工厂 + 释放口）。结果是：任何一个改了字段状态的控制器方法，都在悄悄承担流式语义，
// 而且这个控制器已经在上帝类阈值上（行数超线就会被标准门禁拦下）。
//
// 把三者收进一个对象后，控制器只留四句意图明确的话：
//   `open()`（新回合）/ `push(text)`（增量）/ `flush()`（收尾，零丢失兜底）/ `discard()`（中断或切走）。
//
// ## 两条不变量（与 StreamThrottle 同向，此处再钉一次）
//
// 1. **收尾零丢失**：`flush()` 必须把缓冲区最后一段刷进状态——少了它，最后几个字会被节流吃掉。
// 2. **释放即静默**：`discard()` 之后 `push/flush` 一律 no-op（`StreamThrottle.dispose` 的语义），
//    否则用户点「停止」后迟到的增量会把流式卡片重新点亮。
//
// 纯逻辑、零 React、零 DOM：`patch` 由调用方注入，可直接在 node 下用假时钟单测。

import { StreamThrottle } from './StreamThrottle.js';

/** 写入一段已刷出的增量文本（由调用方决定写进哪份状态）。 */
export type StreamWrite = (text: string) => void;

/** 回合流式缓冲（一个回合一个实例；跨回合复用同一个对象时靠 open/discard 切换）。 */
export class TurnStreamBuffer {
  /** 已刷出增量的落点。 */
  private readonly write: StreamWrite;
  /** 当前在用的节流器（未 open 时为 null）。 */
  private throttle: StreamThrottle | null = null;

  /**
   * @param write 已刷出增量文本的落点（调用方注入 `host.patch` + reducers 的组合）
   */
  public constructor(write: StreamWrite) {
    this.write = write;
  }

  /**
   * 开一个新回合的缓冲（重复调用会先丢弃旧的）。
   * @returns 无
   */
  public open(): void {
    this.discard();
    this.ensure();
  }

  /**
   * 追加一段增量：**没有在飞缓冲时按需开一个**，然后交给节流器。
   *
   * 为什么这里要"自愈"（而不是只在 `open()` 之后才收）：页面上"有回合在跑"（`busy: true`）与
   * "本控制器见过 `open()`"并不总是同时成立——刷新 / 深链恢复出一个正在跑的回合时，缓冲是空的，
   * 但增量已经在推了。若此时静默丢弃，用户看到的就是"连上了、回复却一个字都不来"。
   * 这不影响"释放后不再复活"：`discard()` 只是把句柄置空，节流器实例本身已 `dispose`（终态），
   * 迟到增量会走**新**实例——而调用方（`SessionController.appendTextDelta`）在非 busy 态会先
   * `discard()` 并直接返回，所以真正迟到的增量连这里都到不了。
   * @param delta 增量文本（空串由节流器忽略）
   * @returns 无
   */
  public push(delta: string): void {
    this.ensure().push(delta);
  }

  /**
   * 收尾：把缓冲区最后一段刷进状态并释放（**必须在写最终 assistant 事件之前调用**，
   * 否则最后一段增量会丢）。未 open 时为 no-op。
   * @returns 无
   */
  public flush(): void {
    this.throttle?.flush();
    this.discard();
  }

  /**
   * 丢弃：取消在飞刷新并释放（中断 / 切走 / 换会话时调用），此后 push/flush 均为 no-op。
   * @returns 无
   */
  public discard(): void {
    if (this.throttle === null) return;
    this.throttle.dispose();
    this.throttle = null;
  }

  /**
   * 当前是否有在飞回合缓冲。
   * @returns 有节流器为 true
   */
  public get active(): boolean {
    return this.throttle !== null;
  }

  /**
   * 取当前节流器，没有就建一个（按需自愈，理由见 `push`）。
   * @returns 节流器实例
   */
  private ensure(): StreamThrottle {
    if (this.throttle === null) {
      this.throttle = new StreamThrottle((text) => this.write(text));
    }
    return this.throttle;
  }
}
