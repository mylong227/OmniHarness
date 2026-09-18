// 把后端推送的「插件集 / 插件加载」类通知转成 toast 文案与级别。
//
// 这些事件原先在 SSE 流里被静默丢弃（profile.error / plugin.loaded /
// plugin.loadError）或只触发静默刷新（profile.applied），用户无从得知成败。
// 抽出为纯函数，便于在 AppController 路由时调用，也便于单元测试（无副作用、无外部依赖）。

import type { ToastKind } from '../core/ToastService.js';

/** 一条通知的呈现形态：文案 + 级别。 */
export interface ProfilePluginToast {
  /** 展示文案。 */
  readonly message: string;
  /** 提示级别（ok=成功 / err=错误 / info=信息）。 */
  readonly kind: ToastKind;
}

/**
 * 把后端通知方法 + 参数转成 toast（无副作用）。
 *
 * 覆盖的事件：
 * - `profile.error`    → `{ name, error }`                         错误提示
 * - `plugin.loadError` → `{ name?, error }`                       错误提示
 * - `plugin.loaded`    → `{ names: string[], reloaded?: boolean }` 成功提示（可区分首次/重载）
 * - `profile.applied`  → `{ name, ... }`                          成功提示
 *
 * @param method 后端通知方法名（SSE `msg.method`）。
 * @param params 通知参数（SSE `msg.params`）。
 * @returns 可展示的 toast；不在覆盖范围内的方法返回 `null`。
 */
export function formatProfilePluginToast(method: string, params: Record<string, unknown>): ProfilePluginToast | null {
  const name = typeof params['name'] === 'string' ? (params['name'] as string) : undefined;
  const error = typeof params['error'] === 'string' ? (params['error'] as string) : '未知错误';
  const names = Array.isArray(params['names'])
    ? (params['names'] as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const reloaded = params['reloaded'] === true;
  switch (method) {
    case 'profile.error':
      return { message: `插件集「${name ?? '未知'}」应用失败：${error}`, kind: 'err' };
    case 'plugin.loadError':
      return {
        message: name !== undefined ? `插件「${name}」加载失败：${error}` : `插件加载失败：${error}`,
        kind: 'err',
      };
    case 'plugin.loaded':
      return {
        message: reloaded
          ? `已重新加载插件：${names.join('、')}`
          : `已加载插件：${names.join('、')}`,
        kind: 'ok',
      };
    case 'profile.applied':
      return { message: `已应用插件集「${name ?? '未知'}」`, kind: 'ok' };
    default:
      return null;
  }
}
