// 主题偏好（本机持久化）：`system` / `dark` / `light` 三态。
//
// ## 为什么需要三态（2026-10-18）
//
// 原实现只有 dark / light 两态，且默认写死 dark。问题是：**没做过选择的用户也是 dark**，
// 而"跟随系统"本来是桌面应用的默认期待（系统在日落时切暗色，工具应该跟着走）。
// 于是把「没选过」和「选了跟随系统」合并成同一个偏好值 `system`：
//
//   · localStorage 里没有值        → `system`（首屏按 prefers-color-scheme 决定）
//   · 首次挂载会把解析结果写回 'system'：让"用户确实选了跟随"与"从未选择"落成同一个
//     可读状态，而不是每次启动都重新猜一遍（写 'system' 与不写，行为完全等价）
//   · 用户在设置里选「跟随系统」    → 写 'system'，系统主题变化时实时跟随
//   · 用户在设置/页脚切了明暗       → 写 'dark' / 'light'，从此锁定，不再跟随
//
// 读盘失败（隐私模式 / localStorage 被禁）时一律落到 `system`：宁可跟随系统，也不要把
// 一个"猜"出来的偏好当成用户选择写回去。
//
// 写入的时机：`applyTheme` 只负责"把偏好应用到 document + 持久化"，解析结果返回给调用方，
// 由调用方同步进 React 状态（主题必须首帧前生效，React 状态晚一帧可以接受）。

/** 解析后的主题（真正落在 `<html data-theme>` 上的值）。 */
export type ThemeMode = 'dark' | 'light';

/** 用户偏好（含"跟随系统"）。 */
export type ThemePreference = ThemeMode | 'system';

/** localStorage 键名。沿用旧键，避免升级后老用户的选择丢失。 */
const STORAGE_KEY = 'omni-theme';

/** 系统是否偏好浅色（读不到 matchMedia 时按深色）。 */
function systemTheme(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 把偏好解析成实际主题。 */
export function resolveTheme(pref: ThemePreference): ThemeMode {
  return pref === 'system' ? systemTheme() : pref;
}

/** 读取本机偏好；从未选择过时返回 `system`（不是 `dark`）。 */
export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'system' || raw === 'dark' || raw === 'light') return raw;
  } catch {
    /* 隐私模式下读取会抛：落到 system */
  }
  return 'system';
}

/**
 * 应用偏好：写 `<html data-theme>` + 持久化偏好值（`system` 也如实写回）。
 * @param pref 偏好
 * @returns 解析后的实际主题
 */
export function applyTheme(pref: ThemePreference): ThemeMode {
  const mode = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* 写不进去不影响本次生效 */
  }
  return mode;
}

/**
 * 订阅系统主题变化（仅在偏好为 `system` 时有意义，由调用方判断）。
 * @param onChange 系统主题变化时回调
 * @returns 取消订阅
 */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  } catch {
    return () => undefined;
  }
}
