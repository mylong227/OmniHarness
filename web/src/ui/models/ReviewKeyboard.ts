// 变更审查键盘层：把按键事件解析为「评审动作」，并负责块序号的移动/夹取（零 DOM 依赖，可直测）。
//
// 与 KeyboardShortcuts（全局快捷键）的分工：
//   · 全局表只认 Ctrl/Cmd 组合键，裸键一律放行——因为全局听的是 window，无法判断打字场景；
//   · 本表处理 j/k/a/r/c/? 这类**裸键**，故必须自带「焦点在输入框内则不响应」的判据，
//     否则用户在变更页的评论框里打一个 a 就会把改动块 stage 掉（这是真事故，不是理论风险）。

/** 评审动作标识。 */
export type ReviewAction =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'accept'
  | 'reject'
  | 'comment'
  | 'open'
  | 'help'
  | 'dismiss'
  | 'none';

/** 解析所需的最小按键信息（KeyboardEvent 的结构子集，便于单测直接构造字面量）。 */
export interface ReviewKeyLike {
  /** 按键名（`KeyboardEvent.key`，大小写不敏感）。 */
  key: string;
  /** 事件目标（仅用于判定「是否在输入框内」）。 */
  target?: ReviewTargetLike | null;
  /** 是否按下 Ctrl（按下即让位给全局快捷键）。 */
  ctrlKey?: boolean;
  /** 是否按下 Cmd（macOS）。 */
  metaKey?: boolean;
}

/** 事件目标的最小形状：只要能判定「可打字」即可。 */
export interface ReviewTargetLike {
  /** 标签名（如 `TEXTAREA`），大小写不敏感。 */
  tagName?: string;
  /** 是否处于 contenteditable 编辑态。 */
  isContentEditable?: boolean;
}

/** 一条裸键绑定。 */
interface ReviewBinding {
  /** 命中的按键名集合（小写）。 */
  readonly keys: readonly string[];
  /** 对应动作。 */
  readonly action: ReviewAction;
}

/**
 * 裸键绑定表（唯一来源）。
 * 方向键与 j/k 等价：前者是通用习惯，后者是 vim 习惯，两派用户都不必学新键。
 */
const BINDINGS: readonly ReviewBinding[] = [
  { keys: ['j', 'arrowdown'], action: 'next' },
  { keys: ['k', 'arrowup'], action: 'prev' },
  { keys: ['home'], action: 'first' },
  { keys: ['end'], action: 'last' },
  { keys: ['a'], action: 'accept' },
  { keys: ['r'], action: 'reject' },
  { keys: ['c'], action: 'comment' },
  { keys: ['enter'], action: 'open' },
  { keys: ['?', '/'], action: 'help' },
  { keys: ['escape'], action: 'dismiss' },
];

/** 可打字的标签名（在其中按键必须被忽略，否则会边评论边 stage）。 */
const TYPING_TAGS = new Set(['input', 'textarea', 'select', 'option']);

/** 变更审查键盘解析器（无状态，静态方法即可）。 */
export class ReviewKeyboard {
  /**
   * 判定事件目标是否处于「打字」语境。
   * @param target 事件目标（可为空，如 window 上的合成事件）
   * @returns 属于输入框 / 文本域 / 下拉 / 可编辑区时为 true
   */
  public static isTypingTarget(target: ReviewTargetLike | null | undefined): boolean {
    if (target === null || target === undefined) return false;
    if (target.isContentEditable === true) return true;
    const tag = (target.tagName ?? '').toLowerCase();
    return TYPING_TAGS.has(tag);
  }

  /**
   * 解析按键事件为评审动作。
   * @param e 按键信息（key / target / ctrlKey / metaKey）
   * @returns 命中的动作标识；打字语境、组合键或未绑定键一律为 `none`
   */
  public static resolve(e: ReviewKeyLike): ReviewAction {
    if (ReviewKeyboard.isTypingTarget(e.target)) return 'none';
    // Ctrl/Cmd 组合让位给全局快捷键（⌘N 新建、⌘B 左栏…），本层不抢。
    if (e.ctrlKey === true || e.metaKey === true) return 'none';
    const key = e.key.toLowerCase();
    for (const binding of BINDINGS) {
      if (binding.keys.includes(key)) return binding.action;
    }
    return 'none';
  }

  /**
   * 按动作移动选中序号（越界夹取，不环绕——环绕会让「一直按 j」失去终点感）。
   * @param cursor 当前序号（-1 表示未选中）
   * @param action 动作（仅 next / prev / first / last 会产生位移）
   * @param count 当前数据集的条目数
   * @returns 移动后的序号；数据集为空时为 -1
   */
  public static move(cursor: number, action: ReviewAction, count: number): number {
    if (count <= 0) return -1;
    switch (action) {
      case 'next':
        return ReviewKeyboard.clamp(cursor + 1, count);
      case 'prev':
        return ReviewKeyboard.clamp(cursor - 1, count);
      case 'first':
        return 0;
      case 'last':
        return count - 1;
      default:
        return ReviewKeyboard.clamp(cursor, count);
    }
  }

  /**
   * 夹取序号到 `[0, count-1]`（未选中时归到首项，保证「打开页面即有选中块」）。
   * @param index 原始序号
   * @param count 条目数
   * @returns 合法序号；条目数为 0 时为 -1
   */
  public static clamp(index: number, count: number): number {
    if (count <= 0) return -1;
    if (!Number.isFinite(index)) return 0;
    return Math.max(0, Math.min(count - 1, index));
  }
}
