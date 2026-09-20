// 会话搜索状态机：把「输入 → 防抖 → 远端 search.all → 分组/选中」这段状态收敛到一个零 React 的对象。
//
// 为什么值得单独成类（而不是塞进组件里几个 useState）：
//   · `search.all` 会真实遍历工作区（后端上限 6000 个条目），逐键触发等于每次敲键盘扫一遍盘 ⇒ 必须防抖；
//   · 远端响应可能乱序到达（先发的慢、后发的快），陈旧结果覆盖新结果会让列表「跳回去」⇒ 必须带序号丢弃；
//   · ↑/↓ 选中 + Enter 打开要求「移动与取值读的是同一份权威状态」，逐帧从渲染快照读会漏按键
//     （与 ChangesTab 的 ReviewCursor 同一类问题，同一套解法）。
//
// 组件只做两件事：把 setQuery/key 事件转发进来，把 onUpdate 得到的最新快照渲染出去。

import { SearchHitGrouper } from './SearchHitGrouper.js';
import type { SearchGroup } from './SearchHitGrouper.js';
import type { SearchHit } from '../../types/models.js';

/** 远端搜索返回结构（与 ApiClient.searchAll 对齐）。 */
export interface SearchAllResult {
  /** 文件命中。 */
  readonly files: SearchHit[];
  /** 会话命中。 */
  readonly chats: SearchHit[];
}

/** 定时器调度签名（默认 window.setTimeout；单测注入立即执行版以获得确定性）。 */
export type ScheduleFn = (fn: () => void, ms: number) => unknown;

/** 定时器取消签名。 */
export type CancelFn = (handle: unknown) => void;

/** SessionSearch 的依赖。 */
export interface SessionSearchDeps {
  /** 远端搜索（`api.searchAll` 的适配）。 */
  readonly search: (query: string) => Promise<SearchAllResult>;
  /** 状态变化通知（组件据此重渲染）。 */
  readonly onUpdate: () => void;
  /** 防抖延迟毫秒（默认 220：够合并连打，又不至于让用户等）。 */
  readonly delayMs?: number;
  /** 定时器调度注入点。 */
  readonly schedule?: ScheduleFn;
  /** 定时器取消注入点。 */
  readonly cancel?: CancelFn;
}

/** 会话搜索状态机（零 React 依赖，可直测）。 */
export class SessionSearch {
  /** 依赖（搜索实现 / 通知 / 调度）。 */
  private readonly deps: SessionSearchDeps;

  /** 当前关键字（原文，供 UI 回填）。 */
  private query = '';

  /** 最新分组结果。 */
  private groups: SearchGroup[] = [];

  /** 分组结果的线性视图（选中索引基于它）。 */
  private flat: SearchHit[] = [];

  /** 当前选中序号（-1 表示未选中）。 */
  private index = -1;

  /** 是否正在等待远端响应。 */
  private loading = false;

  /** 请求序号：只接受最新一次请求的响应（防乱序覆盖）。 */
  private seq = 0;

  /** 在途防抖定时器句柄。 */
  private timer: unknown = null;

  /**
   * @param deps 搜索实现、状态通知与调度注入
   */
  public constructor(deps: SessionSearchDeps) {
    this.deps = deps;
  }

  /**
   * 取当前关键字。
   * @returns 关键字原文
   */
  public keyword(): string {
    return this.query;
  }

  /**
   * 取当前分组结果。
   * @returns 分组列表
   */
  public groupList(): readonly SearchGroup[] {
    return this.groups;
  }

  /**
   * 取选中序号。
   * @returns 选中序号；无结果时为 -1
   */
  public selectedIndex(): number {
    return this.index;
  }

  /**
   * 取加载态。
   * @returns 等待远端响应时为 true
   */
  public isLoading(): boolean {
    return this.loading;
  }

  /**
   * 输入变更：空关键字立即清空且**不发远端请求**（本地过滤已够用，别白扫盘）；
   * 非空则防抖后请求，并让在途响应失效。
   * @param value 输入框当前值
   * @returns 无
   */
  public setQuery(value: string): void {
    this.query = value;
    this.clearTimer();
    const q = value.trim();
    if (q === '') {
      this.seq += 1;
      this.groups = [];
      this.flat = [];
      this.index = -1;
      this.loading = false;
      this.deps.onUpdate();
      return;
    }
    this.loading = true;
    this.deps.onUpdate();
    const delay = this.deps.delayMs ?? 220;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.run(q);
    }, delay);
  }

  /**
   * 移动选中（↑/↓）。
   * @param delta 位移（+1 下一项 / -1 上一项）
   * @returns 移动后的序号
   */
  public move(delta: number): number {
    this.index = SearchHitGrouper.move(this.index, delta, this.flat.length);
    this.deps.onUpdate();
    return this.index;
  }

  /**
   * 取当前选中的命中（Enter 打开用）。
   * @returns 命中；未选中或越界时为 null
   */
  public selected(): SearchHit | null {
    if (this.index < 0 || this.index >= this.flat.length) return null;
    return this.flat[this.index] ?? null;
  }

  /**
   * 丢弃在途防抖（组件卸载时调用）。
   * @returns 无
   */
  public dispose(): void {
    this.clearTimer();
    this.seq += 1;
  }

  /**
   * 发起远端搜索并消费结果（失败静默：远端不可用不应挡住本地过滤）。
   * @param q 已 trim 的关键字
   * @returns 无
   */
  private run(q: string): void {
    const mine = ++this.seq;
    this.deps
      .search(q)
      .then((r) => {
        if (mine !== this.seq) return;
        this.apply(q, r);
      })
      .catch(() => {
        if (mine !== this.seq) return;
        this.groups = [];
        this.flat = [];
        this.index = -1;
        this.loading = false;
        this.deps.onUpdate();
      });
  }

  /**
   * 应用一次远端结果：分组 + 确定性排序 + 选中归首项。
   * @param q 对应的关键字
   * @param r 远端返回
   * @returns 无
   */
  private apply(q: string, r: SearchAllResult): void {
    this.groups = SearchHitGrouper.group(r.files ?? [], r.chats ?? [], q);
    this.flat = SearchHitGrouper.flat(this.groups);
    this.index = this.flat.length > 0 ? 0 : -1;
    this.loading = false;
    this.deps.onUpdate();
  }

  /**
   * 清掉在途防抖定时器。
   * @returns 无
   */
  private clearTimer(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  /**
   * 调度一次延迟回调（默认走全局 setTimeout）。
   * @param fn 回调
   * @param ms 延迟毫秒
   * @returns 定时器句柄
   */
  private schedule(fn: () => void, ms: number): unknown {
    if (this.deps.schedule !== undefined) return this.deps.schedule(fn, ms);
    return setTimeout(fn, ms);
  }

  /**
   * 取消定时器（默认走全局 clearTimeout）。
   * @param handle 定时器句柄
   * @returns 无
   */
  private cancel(handle: unknown): void {
    if (this.deps.cancel !== undefined) {
      this.deps.cancel(handle);
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
