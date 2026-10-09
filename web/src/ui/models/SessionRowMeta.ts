// 会话行的「可读性」文案（纯函数、零 React / 零 DOM ⇒ 可在 node --test 下直接判据）。
//
// ## 为什么需要它（2026-10-08 易用性轮，真机截图取证）
//
// 左栏是**主要导航面**，但默认的「按项目分组」与「按时间分组」两个视图里，一行会话只渲染
// 截断后的标题（约 14 个字），悬停显示的却是 `sess_xxx` 这种**内部 ID**：
//
//   title={s.id}   ← 对客户零信息
//
// 真机实测（工作区里 15 条会话）：
//   「在当前目录下先建...」「先读取工作区里的...」「先读取工作区里的...」← 两条**完全同名**
//   悬停任一条都只看到 `sess_muxrgioa_b`
//
// 于是"找到上次那条对话"这件事在默认视图里**做不到**——用户只能靠点进去试。
// 「卡片视图」里其实早就有「N 回合 · X 分钟前」，但它不是默认视图，客户不会去发现。
//
// 本模块把「悬停该显示什么」「行内该补什么」抽成纯函数，两个分组视图共用，
// 判据见 `web/test/sessionRowMeta.test.mjs`。

import type { SessionEntry } from '../shared.js';
import { timeAgo } from '../textUtils.js';

/**
 * 会话行的可读性文案：悬停给什么、行内补什么。纯静态、零 React / 零 DOM。
 */
export class SessionRowMeta {
  /**
   * 悬停提示（`title`）：**完整标题** + 最近活动 + 回合数。
   *
   * 口径是"把人已经看得到的信息补全，并给出看不到的信息"：
   *   · 标题**不截断**（行内是截断的，悬停是唯一能看到全文的地方）；
   *   · 无标题时回落到 id（此时 id 是唯一的身份线索，必须给）；
   *   · 时间 / 回合数**缺什么就不写什么**（不编造 `0 回合`、不写"未知时间"）——
   *     `turns` 在历史会话上可能真的没有。
   * @param s 会话条目
   * @param now 参照时刻（毫秒；判据注入以获得确定性）
   * @returns 悬停文案（恒非空）
   */
  public static hoverTitle(s: SessionEntry, now: number = Date.now()): string {
    const parts: string[] = [s.label !== '' ? s.label : s.id];
    const when = timeAgo(s.updatedAt, now);
    if (when !== '') parts.push(when);
    if (typeof s.turns === 'number') parts.push(`${s.turns} 回合`);
    // id 只在"标题不是 id"时作为**末位**补充：同一句话被用作多个会话标题时，id 是唯一区分依据。
    if (s.label !== '' && s.label !== s.id) parts.push(s.id);
    return parts.join(' · ');
  }

  /**
   * 行内右侧的最近活动时间（用于在**不悬停**时也能分辨"哪条是刚才那一条"）。
   *
   * 用**紧凑形**（`刚刚` / `3分` / `2小时` / `5天`）而不是 `timeAgo` 的完整形
   * （`3 分钟前` / `2 小时前`）——这一格是从**标题的宽度**里抠出来的：左侧栏默认 248px，
   * 真机实测（2026-10-08 截图）完整形会把标题从约 14 字压到约 6 字，
   * 而标题才是客户用来找会话的第一线索。悬停文案里给的仍是完整形，信息一点没少。
   *
   * 空串表示"这一格不渲染"（无 `updatedAt` 或不可解析）——调用方据此跳过该节点，
   * 避免留下一个空的对齐占位。
   * @param s 会话条目
   * @param now 参照时刻（毫秒）
   * @returns 紧凑相对时间文案；不可得时为空串
   */
  public static inlineTime(s: SessionEntry, now: number = Date.now()): string {
    if (!s.updatedAt) return '';
    const t = Date.parse(s.updatedAt);
    if (!Number.isFinite(t)) return '';
    const seconds = Math.max(0, Math.floor((now - t) / 1000));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时`;
    return `${Math.floor(seconds / 86400)}天`;
  }
}
