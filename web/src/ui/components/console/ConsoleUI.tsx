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
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
// 2026-10-30（W4 表单专项）：三个设置原语下沉到 antd——所有设置页经本文件拼装，换这里即全站生效。
import Select from 'antd/es/select';
import Input from 'antd/es/input';
import Switch from 'antd/es/switch';

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
    <Select
      className="csl-select"
      style={width === undefined ? undefined : { width }}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled === true}
      options={options.map((option) => ({ value: option.value, label: option.label }))}
      onChange={(next: string) => onChange(next)}
      popupMatchSelectWidth={false}
    />
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
  const shared = {
    className: 'csl-input' + (mono === true ? ' csl-input--mono' : ''),
    style: width === undefined ? undefined : { width },
    'aria-label': ariaLabel,
    placeholder: placeholder ?? '',
    value,
    disabled: disabled === true,
    autoComplete: 'off',
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    onBlur: () => onCommit?.(),
    onPressEnter: () => onCommit?.(),
  };
  // 密码域走 Input.Password（type=password 语义保留；等宽修饰一并带上）。
  if (type === 'password') return <Input.Password {...shared} />;
  return <Input {...shared} />;
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
    <Switch
      className="csl-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled === true}
      onChange={(next: boolean) => onChange(next)}
    />
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
 * 分段控件（radiogroup 语义，WAI-ARIA 单选组键盘模型）。
 * @param props 组件入参
 * @returns 分段控件节点
 */
export function ConsoleSegmented<V extends string>(props: ConsoleSegmentedProps<V>): ReactElement {
  const { options, value, onChange, ariaLabel } = props;
  /** 段按钮引用：方向键要把焦点送到下一段（整组只有一个 Tab 落点）。 */
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);

  /**
   * ←/→/↑/↓ 环绕、Home/End 到首尾；分段控件是"立即生效"的开关，方向键即选中。
   * @param e 键盘事件
   * @param index 当前段下标
   * @returns 无
   */
  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    let next = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = (index - 1 + options.length) % options.length;
    } else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else return;
    e.preventDefault();
    const target = options[next];
    if (target === undefined) return;
    if (target.value !== value) onChange(target.value);
    refs.current[next]?.focus();
  };

  return (
    <div className="csl-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            ref={(el) => {
              refs.current[index] = el;
            }}
            role="radio"
            aria-checked={on ? 'true' : 'false'}
            tabIndex={on || (selectedIndex < 0 && index === 0) ? 0 : -1}
            className={'csl-seg-item' + (on ? ' on' : '')}
            onClick={() => {
              if (!on) onChange(option.value);
            }}
            onKeyDown={(e: React.KeyboardEvent) => onKeyDown(e, index)}
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
