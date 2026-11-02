// 按分栏筛选设置字段（模型 / 运行时 / 权限三页共用）。
//
// 2026-11-02 从 `SettingsSurface` 抽出：原实现每页各写一份
// `SETTINGS_FIELDS.filter((field) => field.tab === which)`。抽成单一实现后，
// 新增分栏时不会出现「某一页忘了过滤」的漂移。

import { SETTINGS_FIELDS, type SettingsField, type SettingsTabKey } from '../../models/SettingsModel.ts';

/**
 * 取某分栏的全部设置字段（顺序即声明顺序，也就是渲染顺序）。
 * @param which 分栏 key
 * @returns 该分栏的字段清单
 */
export function fieldsOf(which: SettingsTabKey): SettingsField[] {
  return SETTINGS_FIELDS.filter((field) => field.tab === which);
}
