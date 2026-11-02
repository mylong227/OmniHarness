// 设置页「运行时」栏：适配器 / 沙箱字段 + 工作区只读展示。
//
// 2026-11-02 从 `SettingsSurface` 抽出（`check.mjs` 函数体行数铁律：原 `renderRuntime`
// 一个箭头函数 22 行；抽出的目的只是让容器保持薄组合，展示内容逐字未改）。

import { t } from '../../i18n/i18n.ts';
import type { SettingsModel } from '../../models/SettingsModel.ts';
import { ConsoleCard, ConsoleInfoRow, ConsoleSettingRow } from './ConsoleUI.tsx';
import { fieldsOf } from './settingsFields.ts';
import type { Config } from '../../../types/models.ts';

/** 「运行时」栏的入参。 */
export interface SettingsRuntimePaneProps {
  /** 当前服务端配置（未装载时为 null）。 */
  cfg: Config | null;
  /** 设置模型（字段行读写通道）。 */
  settings: SettingsModel;
}

/**
 * 「运行时」栏：适配器与执行环境 + 工作区。
 * @param props 组件入参
 * @returns 运行时页节点
 */
export function SettingsRuntimePane(props: SettingsRuntimePaneProps): ReactElement {
  const { cfg, settings } = props;
  return (
    <>
      <ConsoleCard
        title={t('适配器与执行环境')}
        description={t('适配器决定请求协议；沙箱决定命令在什么隔离层里执行。')}
      >
        {fieldsOf('runtime').map((field) => (
          <ConsoleSettingRow key={String(field.key)} field={field} model={settings} />
        ))}
      </ConsoleCard>
      <ConsoleCard
        title={t('工作区')}
        description={t(
          '工作区由启动参数或用户级配置决定（--workspace / ~/.omniharness/omniharness.json），界面内不提供切换。',
        )}
      >
        <ConsoleInfoRow
          label={t('当前工作区')}
          value={cfg?.workspace !== undefined && cfg.workspace !== '' ? String(cfg.workspace) : '—'}
        />
      </ConsoleCard>
    </>
  );
}
