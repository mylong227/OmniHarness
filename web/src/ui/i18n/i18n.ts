// 国际化（i18n）核心：以「中文原文」为键的单向词条表。
//
// 设计口径（为什么用中文原文当键）：
// - zh 语言恒等回落（t('已保存') === '已保存'），零词条维护成本，存量中文串只需包一层 t()；
// - en 语言查 en/index.ts 聚合的词条表，缺词条时回落中文原文（优雅降级，页面不出空洞），
//   词条完整性由 web/test/i18nCoverage.test.mjs 静态扫描兜底（源码里每个 t('…') 键必须入表）。
//
// 语言状态：模块级单例 + 订阅通知（LayoutController.setLocale 经 App 状态触发全树重渲染，
// 本订阅供未来非 React 场景使用）；持久化 localStorage('omni-locale')，挂载时 initLocale 恢复。

import { EN } from './en/index.js';

/** 支持的语言。 */
export type Locale = 'zh' | 'en';

/** localStorage 持久化键（与 omni-theme 同族）。 */
const STORAGE_KEY = 'omni-locale';

let current: Locale = 'zh';
const listeners = new Set<() => void>();

/** 当前语言。 */
export function getLocale(): Locale {
  return current;
}

/** 订阅语言变化（返回退订函数）。 */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 切换语言并持久化（语言变化的重渲染由 App 状态 patch 承接，这里只管模块态与存储）。
 * @param l 目标语言
 */
export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* 忽略：隐私模式下写不了存储，仅本次会话生效 */
  }
  listeners.forEach((fn) => fn());
}

/** 挂载时恢复上次选择的语言（localStorage 损坏时静默回落 zh）。 */
export function initLocale(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') current = saved;
  } catch {
    /* 忽略 */
  }
}

/** t() 的插值参数形态。 */
export interface I18nParams {
  readonly [key: string]: string | number;
}

/**
 * 取词条：zh 恒回原文；en 查表缺词回落原文。插值用 {name} 占位（replaceAll 语义）。
 * @param key 中文原文（含占位符）
 * @param params 插值参数
 * @returns 当前语言的文案
 */
export function t(key: string, params?: I18nParams): string {
  let s = current === 'en' ? (EN[key] ?? key) : key;
  if (params !== undefined) {
    for (const k of Object.keys(params)) {
      s = s.split('{' + k + '}').join(String(params[k]));
    }
  }
  return s;
}
