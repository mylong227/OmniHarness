// 设置页「权限」栏：审批默认（三档全局默认字段）+ 参数级规则编辑器。
//
// 2026-11-02 从 `SettingsSurface` 抽出（`check.mjs` 函数体行数铁律：原 `renderPermission`
// 一个箭头函数 14 行；抽出的目的只是让容器保持薄组合，展示内容逐字未改）。

import { t } from '../../i18n/i18n.ts';
import type { SettingsModel } from '../../models/SettingsModel.ts';
import { ConsoleCard, ConsoleSettingRow } from './ConsoleUI.tsx';
import { fieldsOf } from './settingsFields.ts';
import { PermissionTab } from '../tabs/PermissionTab.tsx';

/** 「权限」栏的入参。 */
export interface SettingsPermissionPaneProps {
  /** 设置模型（字段行读写通道）。 */
  settings: SettingsModel;
}

/**
 * 「权限」栏：审批默认 + 参数级规则编辑器（后者自带卡片）。
 * @param props 组件入参
 * @returns 权限页节点
 */
export function SettingsPermissionPane(props: SettingsPermissionPaneProps): ReactElement {
  return (
    <>
      <ConsoleCard
        title={t('审批默认')}
        description={t('这三档是全局默认；按命令 / 参数逐个放行或拦截在下方规则表里编辑。')}
      >
        {fieldsOf('permission').map((field) => (
          <ConsoleSettingRow key={String(field.key)} field={field} model={props.settings} />
        ))}
      </ConsoleCard>
      <PermissionTab />
    </>
  );
}
