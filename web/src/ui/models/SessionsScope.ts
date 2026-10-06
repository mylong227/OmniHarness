// 会话列表的**显示范围**（当前项目 / 全部项目）——零 DOM 依赖的单一事实源。
//
// 为什么需要它（2026-10-06 用户口径 + 真机实测）：会话存档是**全局**的
// （`~/.omniharness/sessions/*.jsonl`），每条靠 `session_meta.payload.workspace` 标记归属。
// 服务端 `sessions.list` 缺省只回**当前项目**（避免侧栏被上千条别的项目淹没），但用户必须能
// **一键看到全部**——否则换台机器/换个启动目录就会以为"我的项目数据丢了"。
//
// 选择落 localStorage（本机偏好，不随项目走）；解析失败一律回落"当前项目"（fail-safe 默认）。

/** localStorage 键（唯一，避免各处手写字符串）。 */
const STORAGE_KEY = 'omni-sessions-scope';

/** 显示范围：`current` = 只看当前项目；`all` = 全部项目。 */
export type SessionsScopeMode = 'current' | 'all';

/**
 * 会话列表显示范围的本机偏好（当前项目 / 全部项目）：解析、写回、翻转与 RPC 参数映射。
 */
export class SessionsScope {
  /**
   * 读取本机偏好。
   * @returns `'all'` 仅当显式存过；其余（未存/非法/隐私模式抛错）一律 `'current'`。
   */
  public static read(): SessionsScopeMode {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) === 'all' ? 'all' : 'current';
    } catch {
      return 'current';
    }
  }

  /**
   * 写回本机偏好。
   * @param mode 显示范围。
   * @returns 无返回值（写失败静默：偏好丢失不影响功能）。
   */
  public static write(mode: SessionsScopeMode): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, mode);
    } catch {
      /* 隐私模式等：忽略 */
    }
  }

  /**
   * 翻转显示范围。
   * @param mode 当前范围。
   * @returns 相反的范围。
   */
  public static toggle(mode: SessionsScopeMode): SessionsScopeMode {
    return mode === 'all' ? 'current' : 'all';
  }

  /**
   * 转成 `sessions.list` 的 workspace 参数。
   * @param mode 显示范围。
   * @returns `'*'`（全部）或 undefined（缺省＝当前项目）。
   */
  public static workspaceParam(mode: SessionsScopeMode): string | undefined {
    return mode === 'all' ? '*' : undefined;
  }
}
