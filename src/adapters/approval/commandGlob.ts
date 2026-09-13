/**
 * 命令 glob 匹配（零依赖）：把 glob 模式编译为锚定整串正则并匹配文本。
 *
 * 背景：审批规则的命令约束此前只有 `commandPrefix`（前缀匹配），无法表达「拒绝任何含
 * `rm -rf` 的命令」这类参数级规则（前缀匹配只能约束命令开头）。glob 是 Codex / Claude Code
 * 的 allow/deny 列表表达参数级约束的最小形态。
 *
 * 取舍（fail-closed）：只支持 `*`（任意串）与 `?`（单字符）两个通配符，其余字符
 * （含正则元字符如 `.` `+` `(`）一律转义为**字面量**——避免用户拿 `.*` 之类语法「显式写正则」，
 * 使匹配范围不可预期。空模式视为「不匹配任何文本」，由配置校验前置拦截（校验拒绝空串）。
 */

/** 正则元字符（需转义为字面量）。 */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** glob 匹配器：把 `*` / `?` 模式编译为整串锚定正则。 */
export class CommandGlob {
  /**
   * 把 glob 模式编译为锚定正则（`^...$`，`s` 旗标使 `.` 亦匹配换行）。
   * @param pattern glob 模式（`*` 任意串、`?` 单字符、其余字符字面量）。
   * @returns 整串匹配的正则（空模式退化为仅匹配空串）。
   */
  public toRegExp(pattern: string): RegExp {
    let source = '^';
    for (const ch of pattern) {
      if (ch === '*') {
        source += '.*';
      } else if (ch === '?') {
        source += '.';
      } else {
        source += ch.replace(REGEX_META, '\\$&');
      }
    }
    return new RegExp(`${source}$`, 's');
  }

  /**
   * 判断文本是否匹配 glob 模式。
   * @param pattern glob 模式（`*` 任意串、`?` 单字符）。
   * @param text 待匹配文本（如命令原文）。
   * @returns 整串匹配为 true；空模式恒为 false（fail-closed）。
   */
  public matches(pattern: string, text: string): boolean {
    if (pattern === '') {
      return false;
    }
    return this.toRegExp(pattern).test(text);
  }
}

/** 默认无状态实例（可并发复用，调用点以 `commandGlob.xxx` 零构造复用）。 */
export const commandGlob = new CommandGlob();
