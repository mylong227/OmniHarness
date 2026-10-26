/** CSP 指令拼接（独立类，避免加载器继续膨胀）。 */
import type { DesktopCspConfig } from './types.ts';

/** 默认拼装顺序（与 `DEFAULT_DESKTOP_CONFIG.security.csp` 的字段顺序一致）。 */
const ORDER: readonly (keyof DesktopCspConfig)[] = [
  'defaultSrc',
  'scriptSrc',
  'styleSrc',
  'imgSrc',
  'fontSrc',
  'connectSrc',
  'frameSrc',
  'mediaSrc',
  'baseUri',
  'formAction',
  'objectSrc',
  'frameAncestors',
];

/** CSP 格式化器。 */
export class CspFormatter {
  /**
   * 把 CSP 配置拼成响应头值。
   * @param csp 指令表。
   * @returns `default-src ...; script-src ...` 形式。
   */
  public static format(csp: DesktopCspConfig): string {
    const parts: string[] = [];
    for (const key of ORDER) {
      const tokens = csp[key];
      if (tokens.length === 0) continue;
      const name = key.replace(/[A-Z]/gu, (ch) => `-${ch.toLowerCase()}`);
      parts.push(`${name} ${tokens.join(' ')}`);
    }
    return parts.join('; ');
  }
}
