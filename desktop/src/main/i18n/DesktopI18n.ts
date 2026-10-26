/**
 * 桌面壳 i18n（中英）。
 *
 * - `language` 配置支持 `system` / `zh-CN` / `en-US`；`system` 按 Electron 的 `app.getLocale()`
 *   解析（`en*` → 英文，其余 → 中文），与渲染层语言偏好解耦。
 * - 文案集中在本目录 `messages.ts`；业务代码只用键，不再散落中文字面量。
 * - 纯逻辑、不 import electron，可在 `node --test` 里直接跑。
 */
import { DESKTOP_MESSAGES, type DesktopMessageKey } from './messages.ts';

/** 支持的桌面语言。 */
export type DesktopLocale = 'zh-CN' | 'en-US';

/** 配置里的语言取值。 */
export type DesktopLanguageSetting = 'system' | DesktopLocale;

/** 语言解析结果。 */
export class DesktopI18n {
  /**
   * @param locale 生效语言。
   */
  public constructor(public readonly locale: DesktopLocale) {}

  /**
   * 把配置值解析成具体语言。
   * @param setting 配置值（缺省按 system）。
   * @param systemLocale Electron `app.getLocale()` 的返回值。
   * @returns 具体语言。
   */
  public static resolve(
    setting: DesktopLanguageSetting | undefined,
    systemLocale: string,
  ): DesktopLocale {
    if (setting === 'zh-CN' || setting === 'en-US') return setting;
    return systemLocale.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
  }

  /**
   * 取文案并替换 `{name}` 占位符。
   * @param key 文案键。
   * @param params 占位符参数。
   * @returns 本地化文本；未知键原样返回键名（便于诊断，不抛错）。
   */
  public t(key: DesktopMessageKey, params: Record<string, string | number> = {}): string {
    const template = DESKTOP_MESSAGES[this.locale][key] ?? key;
    return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (match, name: string) =>
      params[name] === undefined ? match : String(params[name]),
    );
  }
}
