// 左栏会话的**用户指定顺序**：把「拖拽」翻译成一次数组移动，并保持结果可用于持久化。
//
// ## 口径
//
// 顺序是「用户显式排的」优先，未排过的会话仍按时间倒序排在其后（见服务端 `SessionArchive.list`）。
// 因此这里只做**一次移动**的纯计算：把 `fromId` 移到 `toId` 的位置（`toId` 之前/之后由调用方决定，
// 本实现为「插到 toId 当前位置」，与 Codex 的拖拽落点手感一致：落点行被顶下去）。
//
// 纯计算、零 React、零 DOM：可直接单测（见 web/test/sessionOrder.test.mjs）。

/** 带 id 的条目。 */
interface Identified {
  readonly id: string;
}

/** 会话顺序工具。 */
export class SessionOrder {
  /**
   * 把 `fromId` 移到 `toId` 的位置。
   *
   * 边界：id 不存在 / 同一个 id / 数组为空时**原样返回副本**（幂等，不抛错）——拖拽落点常常就是
   * 自己那一行，不能因此打断交互。
   * @param items 当前顺序
   * @param fromId 被拖动的 id
   * @param toId 落点 id
   * @returns 新顺序（新数组；输入不被修改）
   */
  public static move<T extends Identified>(items: readonly T[], fromId: string, toId: string): T[] {
    const out = items.slice();
    const from = out.findIndex((x) => x.id === fromId);
    const to = out.findIndex((x) => x.id === toId);
    if (from < 0 || to < 0 || from === to) return out;
    const [moved] = out.splice(from, 1);
    if (moved === undefined) return out;
    out.splice(to, 0, moved);
    return out;
  }
}
