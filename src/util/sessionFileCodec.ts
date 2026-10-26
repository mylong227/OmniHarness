/**
 * 会话存档文件名编解码（2026-10-25，修桌面「创建检查点失败: ENOENT」）。
 *
 * ## 为什么需要
 *
 * `StoragePort` 用**合成 sessionId** 承载检查点数据（`checkpoint:<sid>:<label>`、
 * `checkpoint_index:<sid>`）。`JsonlStorage` 与 `SessionArchiveLayout` 直接把 sessionId 拼进
 * 文件名；Windows 文件名不允许 `:`（它被解释为 NTFS 数据流），`open(...checkpoint:...jsonl.tmp)`
 * 直接 ENOENT/非法。POSIX 能建出带冒号的文件，但同样不可移植。
 *
 * ## 契约
 *
 * - 普通会话 id（`sess_...`、字母数字/`_`/`-`）**逐字节不变**，不破坏既有存档；
 * - 含 Windows 非法字符（`<>:"/\|?*`）或控制字符的 key 用 `encodeURIComponent` 转义；
 * - 编码是幂等的；解码失败时原样返回（不抛错，列表/诊断不因一个坏名中断）。
 */
export class SessionFileCodec {
  /** Windows 保留字符（encodeURIComponent 会转义其中大部分，这里显式列出便于阅读）。 */
  private static readonly WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/u;

  /**
   * 把 sessionId 编码成可落盘的文件名基名。
   * @param sessionId 原始会话标识（可能是合成 key）。
   * @returns 可安全用于 Windows/POSIX 文件名的基名。
   */
  public static encode(sessionId: string): string {
    if (sessionId === '') return '_';
    if (!SessionFileCodec.WINDOWS_ILLEGAL.test(sessionId)) return sessionId;
    return encodeURIComponent(sessionId);
  }

  /**
   * 把文件名基名解码回 sessionId。
   * @param fileBase 文件基名（不含 `.jsonl`）。
   * @returns 原始 sessionId；不是合法编码时原样返回。
   */
  public static decode(fileBase: string): string {
    if (!fileBase.includes('%')) return fileBase;
    try {
      return decodeURIComponent(fileBase);
    } catch {
      return fileBase;
    }
  }
}
