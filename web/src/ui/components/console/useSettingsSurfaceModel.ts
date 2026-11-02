// 设置页的模型生命周期：惰性单例 + `useSyncExternalStore` 订阅 + 首次装载。
//
// 2026-11-02 从 `SettingsSurface` 抽出（`check.mjs` 函数体行数铁律：原容器 499 行）。
// 语义与抽出前逐字一致：
//   · 模型只在**首次渲染**构造，切页不重建（避免每切一次都重拉配置）；
//   · **不在这里 dispose 模型**：StrictMode 会在开发态重跑 effect，若第一次清理就把实例
//     标记成 disposed，之后「已保存」提示会永久失效。实例只在控制台关闭、组件真正卸载后
//     由 GC 回收；定时器最多空跑一次。

import * as React from 'react';
import { SettingsModel, type SettingsSnapshot } from '../../models/SettingsModel.ts';
import type { AppContextValue } from '../../context.ts';
import type { Profile } from '../../../types/models.ts';

/** 构造设置模型所需的依赖（全部来自 `useApp()`）。 */
export interface SettingsModelContext {
  /** 服务端客户端。 */
  api: AppContextValue['api'];
  /** 提示通道。 */
  toast: AppContextValue['toast'];
  /** 厂商目录刷新。 */
  refreshModelCatalog: AppContextValue['refreshModelCatalog'];
}

/** 设置页拿到的模型与当前快照。 */
export interface SettingsSurfaceModel {
  /** 状态与读写通道（引用稳定）。 */
  settings: SettingsModel;
  /** 当前快照（`useSyncExternalStore` 的取值源）。 */
  snapshot: SettingsSnapshot;
}

/**
 * 模型未就绪时的稳定空快照（`useSyncExternalStore` 要求引用稳定）。
 */
const EMPTY_SNAPSHOT: SettingsSnapshot = {
  cfg: null,
  baseUrl: '',
  profiles: [],
  activePlugins: '',
  savedHint: '',
  saving: false,
  error: '',
  loadError: '',
};

/**
 * 构造设置模型（依赖 `useApp` 提供的 api / toast / 厂商目录刷新）。
 * @param ctx 应用上下文
 * @returns 模型实例（调用方负责 dispose）
 */
export function createSettingsModel(ctx: SettingsModelContext): SettingsModel {
  return new SettingsModel({
    getConfig: () => ctx.api.getConfig(),
    updateConfig: (patch) => ctx.api.updateConfig(patch),
    listProfiles: () => ctx.api.listProfiles() as Promise<Profile[]>,
    getActiveProfile: () => ctx.api.getActiveProfile(),
    applyProfile: (id) => ctx.api.applyProfile(id),
    refreshModelCatalog: ctx.refreshModelCatalog,
    toast: (message, kind) => ctx.toast(message, kind),
  });
}

/**
 * 创建并订阅设置模型，首次渲染触发一次装载。
 * @param ctx 应用上下文
 * @returns 模型实例与当前快照
 */
export function useSettingsSurfaceModel(ctx: SettingsModelContext): SettingsSurfaceModel {
  // 惰性单例：切页不重建模型（避免每切一次都重拉配置）。
  const modelRef = React.useRef<SettingsModel | null>(null);
  if (modelRef.current === null) {
    modelRef.current = createSettingsModel(ctx);
  }
  const settings = modelRef.current;

  const snapshot = React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => (modelRef.current === null ? () => undefined : modelRef.current.subscribe(notify)),
      [],
    ),
    () => (modelRef.current === null ? EMPTY_SNAPSHOT : modelRef.current.getSnapshot()),
  );

  // 装载一次配置。**不在这里 dispose 模型**（原因见文件头）。
  React.useEffect(() => {
    void settings.load();
  }, [settings]);

  return { settings, snapshot };
}
