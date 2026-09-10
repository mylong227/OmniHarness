// 路径拼接：把目录与子项名拼成绝对路径。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 路径拼接器（Windows / POSIX 双栈兼容）。 */
export class PathJoiner {
  /**
   * 拼接父目录与子项名：自动识别分隔符（父路径含反斜杠即按 Windows 处理），
   * 并去掉父目录尾部分隔符，避免出现 `a\\` + `\\b` 的双分隔符。
   */
  public static join(parent: string, name: string): string {
    if (parent === '') return name;
    const sep = parent.includes('\\') ? '\\' : '/';
    const trimmed = parent.endsWith('\\') || parent.endsWith('/') ? parent.slice(0, -1) : parent;
    return trimmed + sep + name;
  }

  /** 取路径末段（先去掉尾部分隔符）：`D:/demo/app/` → `app`；空串返回原样。 */
  public static basename(p: string): string {
    const trimmed = p.replace(/[\\/]+$/, '');
    if (trimmed === '') return p;
    return trimmed.split(/[\\/]/).pop() ?? p;
  }

  /** 规范化比较键：去掉尾部分隔符，用于「当前工作区」匹配。 */
  public static normalize(p: string): string {
    return p.replace(/[\\/]+$/, '');
  }
}
