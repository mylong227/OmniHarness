// 控制台（设置中心）的通用排版件：卡片 / 设置行 / 下拉 / 输入 / 开关 / 分段控件。
//
// 这些组件的形状直接对应 2026-10-26 用户给的结构参考：左侧分组导航，右侧是
// 「标题 + 说明 + 一张张卡片」，卡片里每一行左侧是"这一项是什么"，右侧是控件。
// 所有设置页都只由这里拼装，避免各页再写一套 <label><select> 导致控件长相漂移。
//
// 纯展示组件：值由调用方注入，不直接读 localStorage / 全局状态。

import * as React from 'react';
import { icon } from '../../models/Icon.ts';
import type { IconName } from '../../models/Icon.ts';
import { t } from '../../i18n/i18n.ts';
import type { SettingsField, SettingsModel } from '../../models/SettingsModel.ts';

/** 下拉选项。 */
export interface ConsoleOption {
  /** 实际值。 */
  readonly value: string;
  /** 展示文案。 */
  readonly label: string;
}

/** 卡片：标题（可选）+ 说明 + 若干行 + 末尾注释。 */
export interface ConsoleCardProps {
  /** 卡片标题（同一页里区分几组设置）。 */
  title?: string;
  /** 标题右侧的轻量元信息（计数 / 状态）。 */
  meta?: React.ReactNode;
  /** 标题下的一句话。 */
  description?: string;
  /** 标题右侧的操作按钮。 */
  actions?: React.ReactNode;
  /** 卡片主体（通常是 ConsoleRow 序列）。 */
  children: React.ReactNode;
  /** 卡片末尾的脚注（实验性说明 / 安全边界）。 */
  footer?: React.ReactNode;
  /** 追加类名（如窄卡片）。 */
  className?: string;
}

/**
 * 一张设置卡片。
 * @param props 组件入参
 * @returns 卡片节点
 */
export function ConsoleCard(props: ConsoleCardProps): ReactElement {
  const { title, meta, description, actions, children, footer, className } = props;
  const hasHead =
    title !== undefined || meta !== undefined || description !== undefined || actions !== undefined;
  return (
    <section className={'csl-card' + (className === undefined ? '' : ' ' + className)}>
      {hasHead ? (
        <div className="csl-card-head">
          <div className="csl-card-head-main">
            {title === undefined ? null : (
              <div className="csl-card-title-row">
                <h2 className="csl-card-title">{title}</h2>
                {meta === undefined ? null : <span className="csl-card-meta">{meta}</span>}
              </div>
            )}
            {description === undefined ? null : (
              <p className="csl-card-desc">{description}</p>
            )}
          </div>
          {actions === undefined ? null : <div className="csl-card-actions">{actions}</div>}
        </div>
      ) : null}
      <div className="csl-card-body">{children}</div>
      {footer === undefined ? null : <div className="csl-card-foot">{footer}</div>}
    </section>
  );
}

/** 一行设置：左侧标签 + 说明，右侧控件。 */
export interface ConsoleRowProps {
  /** 这一项的名字。 */
  label: string;
  /** 一句话解释（可省略）。 */
  hint?: string;
  /** 右侧控件；省略时这一行就是纯信息行。 */
  children?: React.ReactNode;
  /** 控件下方整宽内容（例如规则列表）。 */
  below?: React.ReactNode;
}

/**
 * 一行设置。
 * @param props 组件入参
 * @returns 行节点
 */
export function ConsoleRow(props: ConsoleRowProps): ReactElement {
  const { label, hint, children, below } = props;
  return (
    <div className={'csl-row' + (children === undefined ? ' csl-row--info' : '')}>
      <div className="csl-row-main">
        <span className="csl-row-label">{label}</span>
        {hint === undefined ? null : <span className="csl-row-hint">{hint}</span>}
      </div>
      {children === undefined ? null : <div className="csl-row-control">{children}</div>}
      {below === undefined ? null : <div className="csl-row-below">{below}</div>}
    </div>
  );
}

/** 只读信息行（值在右侧，等宽字体）。 */
export interface ConsoleInfoRowProps {
  /** 信息项名称。 */
  label: string;
  /** 值（路径 / 版本 / 数量）。 */
  value: string;
  /** 悬浮完整值。 */
  title?: string;
}

/**
 * 只读信息行。
 * @param props 组件入参
 * @returns 行节点
 */
export function ConsoleInfoRow(props: ConsoleInfoRowProps): ReactElement {
  const { label, value, title } = props;
  return (
    <div className="csl-row csl-row--info">
      <div className="csl-row-main">
        <span className="csl-row-label">{label}</span>
      </div>
      <div className="csl-row-control">
        <span className="csl-value" title={title ?? value}>
          {value}
        </span>
      </div>
    </div>
  );
}

/** 下拉控件。 */
export interface ConsoleSelectProps {
  /** 当前值。 */
  value: string;
  /** 选项。 */
  options: readonly ConsoleOption[];
  /** 变更回调。 */
  onChange: (value: string) => void;
  /** 无障碍名字（行里已有可见标签时仍建议给出，便于屏幕阅读器直接定位控件）。 */
  ariaLabel: string;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 宽度（CSS 值，默认按内容）。 */
  width?: string;
}

/**
 * 带自绘箭头的原生下拉（原生 select 保证键盘与移动端行为，外观走 CSS）。
 * @param props 组件入参
 * @returns 下拉节点
 */
export function ConsoleSelect(props: ConsoleSelectProps): ReactElement {
  const { value, options, onChange, ariaLabel, disabled, width } = props;
  return (
    <span className="csl-select-wrap" style={width === undefined ? undefined : { width }}>
      <select
        className="csl-select"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled === true}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="csl-select-caret" aria-hidden="true">
        {icon('chevron-down', { size: 12 })}
      </span>
    </span>
  );
}

/** 文本输入。 */
export interface ConsoleInputProps {
  /** 当前值（受控）。 */
  value: string;
  /** 变更回调。 */
  onChange: (value: string) => void;
  /** 失焦 / 回车提交（用于"写完才落盘"的字段）。 */
  onCommit?: () => void;
  /** 无障碍名字。 */
  ariaLabel: string;
  /** 占位提示。 */
  placeholder?: string;
  /** 输入类型（密码 / 文本）。 */
  type?: 'text' | 'password';
  /** 是否等宽字体（路径 / URL）。 */
  mono?: boolean;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 宽度（CSS 值）。 */
  width?: string;
}

/**
 * 文本输入框；回车或失焦时提交。
 * @param props 组件入参
 * @returns 输入节点
 */
export function ConsoleInput(props: ConsoleInputProps): ReactElement {
  const { value, onChange, onCommit, ariaLabel, placeholder, type, mono, disabled, width } = props;
  return (
    <input
      className={'csl-input' + (mono === true ? ' csl-input--mono' : '')}
      style={width === undefined ? undefined : { width }}
      type={type ?? 'text'}
      aria-label={ariaLabel}
      placeholder={placeholder ?? ''}
      value={value}
      disabled={disabled === true}
      autoComplete="off"
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      onBlur={() => onCommit?.()}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') onCommit?.();
      }}
    />
  );
}

/** 开关。 */
export interface ConsoleSwitchProps {
  /** 是否开启。 */
  checked: boolean;
  /** 变更回调。 */
  onChange: (checked: boolean) => void;
  /** 无障碍名字。 */
  label: string;
  /** 是否禁用。 */
  disabled?: boolean;
}

/**
 * 自绘开关（原生 checkbox 保证键盘与表单语义，外观走 CSS）。
 * @param props 组件入参
 * @returns 开关节点
 */
export function ConsoleSwitch(props: ConsoleSwitchProps): ReactElement {
  const { checked, onChange, label, disabled } = props;
  return (
    <label className={'csl-switch' + (disabled === true ? ' is-disabled' : '')}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled === true}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
      />
      <span className="csl-switch-track" aria-hidden="true" />
    </label>
  );
}

/** 分段控件选项。 */
export interface ConsoleSegmentOption<V extends string> {
  /** 实际值。 */
  readonly value: V;
  /** 展示文案。 */
  readonly label: string;
  /** 可选的线性图标。 */
  readonly icon?: IconName;
}

/** 分段控件：2–3 个互斥选择，全部摊开（不藏进下拉）。 */
export interface ConsoleSegmentedProps<V extends string> {
  /** 选项。 */
  options: readonly ConsoleSegmentOption<V>[];
  /** 当前值。 */
  value: V;
  /** 变更回调。 */
  onChange: (value: V) => void;
  /** 无障碍名字。 */
  ariaLabel: string;
}

/**
 * 分段控件（radiogroup 语义）。
 * @param props 组件入参
 * @returns 分段控件节点
 */
export function ConsoleSegmented<V extends string>(props: ConsoleSegmentedProps<V>): ReactElement {
  const { options, value, onChange, ariaLabel } = props;
  return (
    <div className="csl-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on ? 'true' : 'false'}
            className={'csl-seg-item' + (on ? ' on' : '')}
            onClick={() => {
              if (!on) onChange(option.value);
            }}
          >
            {option.icon === undefined ? null : icon(option.icon, { size: 13 })}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 键帽。 */
export interface ConsoleKeycapProps {
  /** 按键组合（如 `Ctrl/Cmd+P`）。 */
  combo: string;
}

/**
 * 键帽（快捷键页用）。
 * @param props 组件入参
 * @returns 键帽节点
 */
export function ConsoleKeycap(props: ConsoleKeycapProps): ReactElement {
  const { combo } = props;
  return <kbd className="csl-kbd">{combo}</kbd>;
}

/**
 * 把一个设置字段渲染成控制台行（下拉 / 文本 / 开关）。
 *
 * 文本字段用**本地草稿 + 失焦提交**：旧实现每敲一个字符就发一次 config.update，
 * 既慢又会把半截 URL 写进配置（用户还没输入完就已落盘）。下拉与开关仍然即时提交。
 * @param props 组件入参
 * @returns 行节点
 */
export function ConsoleSettingRow(props: {
  field: SettingsField;
  model: SettingsModel;
}): ReactElement {
  const { field, model } = props;
  const label = t(field.label);
  const hint = field.hint === undefined ? undefined : t(field.hint);
  const committed = model.valueOf(field.key);

  // 文本草稿：外部值变化（装载 / 保存后重拉）时同步进来。
  const [draft, setDraft] = React.useState(committed);
  React.useEffect(() => {
    setDraft(committed);
  }, [committed]);

  if (field.kind === 'switch') {
    return (
      <ConsoleRow label={label} hint={hint}>
        <ConsoleSwitch
          checked={model.boolOf(field.key)}
          label={label}
          onChange={(checked) => void model.saveField(field, checked)}
        />
      </ConsoleRow>
    );
  }
  if (field.kind === 'select') {
    return (
      <ConsoleRow label={label} hint={hint}>
        <ConsoleSelect
          ariaLabel={label}
          value={committed}
          options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
          onChange={(value) => void model.saveField(field, value)}
        />
      </ConsoleRow>
    );
  }
  return (
    <ConsoleRow label={label} hint={hint}>
      <ConsoleInput
        ariaLabel={label}
        value={draft}
        placeholder={field.placeholder === undefined ? undefined : t(field.placeholder)}
        mono
        onChange={setDraft}
        onCommit={() => {
          if (draft.trim() !== committed.trim()) void model.saveField(field, draft);
        }}
      />
    </ConsoleRow>
  );
}
