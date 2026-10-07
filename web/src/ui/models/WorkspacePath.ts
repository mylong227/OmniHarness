// 工作区（项目）路径的**最小归一**（web 侧）：只服务于「这个会话属于哪个项目」的判定与展示，
// 不碰盘、不解析软链。
//
// 为什么 web 侧也要有一份（2026-10-07 用户报「在 A 项目下的会话，去 B 项目打开，会话会自己串过来」）：
// 打开会话前要判断"它是不是当前项目的"，而会话存档里的标记历史上出现过 `D:\x` / `D:/x` / 大小写变体
// 三种拼写；字面量比较会把同一个项目判成两个，于是"切过去"这一步被漏掉、会话就串到别的项目里显示。
// 服务端口径见 `src/util/workspaceIdentity.ts`（那边多一条跑测目录折叠，web 侧不需要）。

/** 工作区路径归一与比较。 */
export class WorkspacePath {
  /**
   * 归一：`/` → `\`、折叠重复分隔符、去尾分隔符、盘符大写、两侧空白去掉。
   * @param raw 原始路径（可能为空）。
   * @returns 归一后的路径；空输入返回空串（= 无归属）。
   */
  public static normalize(raw: string | undefined): string {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return '';
    let value = trimmed.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
    if (value.length > 3 && value.endsWith('\\')) value = value.slice(0, -1);
    return /^[a-zA-Z]:/.test(value) ? value[0]!.toUpperCase() + value.slice(1) : value;
  }

  /**
   * 两条路径是否指同一个项目。
   * @param a 路径 a。
   * @param b 路径 b。
   * @returns 同项目为 true；任一侧为空为 false。
   */
  public static same(a: string | undefined, b: string | undefined): boolean {
    const na = WorkspacePath.normalize(a);
    const nb = WorkspacePath.normalize(b);
    if (na === '' || nb === '') return false;
    // 盘符路径大小写不敏感（同目录的两种拼写不得判成两个项目），POSIX 路径保持敏感。
    const windowsLike = /^[a-zA-Z]:/.test(na) && /^[a-zA-Z]:/.test(nb);
    return windowsLike ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  }

  /**
   * 展示名：路径最后一段（空路径显示占位）。
   * @param raw 原始路径。
   * @returns 末段名或 `未归属`。
   */
  public static label(raw: string | undefined): string {
    const value = WorkspacePath.normalize(raw);
    if (value === '') return '未归属';
    const parts = value.split('\\').filter((p) => p !== '');
    return parts[parts.length - 1] ?? value;
  }
}
