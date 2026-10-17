// 模型选择弹窗（把「模型」与「推理强度」合到一处）
//
// 为什么合并（2026-10-17 用户要求）：
//   输入区原先并排两个下拉——「推理强度」与「模型」——各占一格，加在一起是输入行里
//   最宽的两块 chrome，而它们其实是**同一个决定的两半**：换模型往往就要跟着调强度。
//   合并后输入行少一个控件，且"模型 + 它的强度"在同一个面板里一次看完。
//
// 为什么档位改成进度条（而不是继续用列表）：
//   强度是一维的**有序量**，列表却把它表达成并列的 5 个词（极简/弱/中/强/极强），
//   读数要靠把词翻译成序。进度条把这个序直接画出来——填充比例就是强度，
//   一眼可读、可盲点（点第 4 段就是"强"），且与单色体系天然相容（只用明度表达）。
//
// 无障碍口径：模型是 `listbox + option`（点击即选），档位是 `radiogroup + radio`
// （每段是可聚焦的 radio，方向键切换）。两处都不靠颜色区分，符合 DESIGN_SYSTEM §2.4。
//
// 2026-10-17 二次调整：删除了模型**筛选框**。模型清单通常只有个位数（真实厂商 3–10 个），
// 筛选框却让每次打开都多出一次"忽略它 / 先输字"的决策，还占掉列表上方一整行。
// 清单长到需要筛选时再加回来——那时它才有存在理由。

import * as React from 'react';
import { icon } from '../models/Icon.ts';
import { ComposerOptions } from '../models/ComposerOptions.ts';
import { claimPopover, releasePopover } from '../models/PopoverStack.ts';
import { t } from '../i18n/i18n.ts';

/** 本弹层在互斥控制器里的身份。 */
const POPOVER_ID = 'model';

/** ModelPicker 组件的入参。 */
export interface ModelPickerProps {
  /** 当前模型值。 */
  model: string;
  /** 可用模型清单（服务端下发优先）。 */
  modelOptions?: readonly string[];
  /** 当前推理强度。 */
  reasoning: string;
  /** 该厂商合法的强度档位（决定进度条有几段）。 */
  reasoningOptions?: readonly string[];
  /** 厂商展示名（可选，用于标题后缀）。 */
  providerLabel?: string;
  /** 选中模型。 */
  onModelChange: (m: string) => void;
  /** 选中强度。 */
  onReasoningChange: (v: string) => void;
}

/**
 * 组合选择器：模型清单 + 推理强度进度条。
 * @param props 组件入参
 * @returns 弹窗节点
 */
export function ModelPicker(props: ModelPickerProps): ReactElement {
  const { model, modelOptions, reasoning, reasoningOptions, providerLabel, onModelChange, onReasoningChange } = props;
  const [open, setOpen] = React.useState<boolean>(false);

  // 展开期间才挂外部点击监听；收起或卸载即摘除（与 Dropdown 同一口径）。
  // 同时登记到互斥控制器：打开本弹层会自动收起其它弹层（见 PopoverStack 头注释）。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    claimPopover({ id: POPOVER_ID, close });
    return () => {
      window.removeEventListener('click', close);
      releasePopover(POPOVER_ID);
    };
  }, [open]);

  /** 触发按钮：阻断冒泡后切换展开态（阻断后不会立刻被「外部点击」判定关掉）。 */
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const next = !open;
    if (next) claimPopover({ id: POPOVER_ID, close: () => setOpen(false) });
    else releasePopover(POPOVER_ID);
    setOpen(next);
  };

  /** 菜单容器：阻断冒泡，避免点击菜单内部被误判为「外部点击」。 */
  const stopBubble = (e: React.MouseEvent): void => {
    e.stopPropagation();
  };

  /** 键盘：Esc 收起（与外部点击同一条出口；同时释放互斥登记）。 */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      releasePopover(POPOVER_ID);
      setOpen(false);
    }
  };

  // 2026-10-17：**筛选框已删除**（用户要求）。理由不只是"多余"——厂商可用模型通常只有个位数
  // （夹具 2 个、真实厂商 3–10 个），而筛选框让"打开弹窗"多出一次"要么忽略它、要么先输字"的
  // 决策成本，还占掉列表上方一整行高度。清单长到需要筛选时再加回来（那时它才有存在理由）。
  const models = ComposerOptions.models(model, modelOptions);
  const ladder = ComposerOptions.ladder(reasoningOptions, reasoning);
  const step = Math.max(0, ladder.findIndex((o) => o.value === reasoning));
  const currentLabel = ComposerOptions.reasoningLabel(reasoning);
  const hasLadder = ladder.length > 0;
  // 当前档位不属于该厂商的合法集合（换模型后常见）：此时它是"当前值"但不是"这一档强度"，
  // 进度条不能照常填满——否则读数虚高。见 OptionItem.unsupported 的注释。
  const currentUnsupported =
    reasoning !== '' && ladder.some((o) => o.value === reasoning && o.unsupported === true);
  /**
   * 触发按钮上的两段文案。
   *
   * 强度只在"该厂商确实有档位"且"当前值非空"时才显示：本地/未知厂商的 `reasoningEffort`
   * 可能是空数组（providers.json 里 Ollama 就是"空数组让 UI 显示无推理档位"），
   * 那时显示一个空强度会让按钮读起来像坏了。模型名缺失（未接入）则回落到「模型」占位。
   */
  const label = model !== '' ? model : t('模型');
  const reasoningLabel =
    reasoning !== '' && hasLadder ? ComposerOptions.reasoningLabel(reasoning) : '';

  /**
   * 方向键切档位：进度条是有序量，用户预期左右键能连续调（而不是必须 Tab 到某一段）。
   * @param e 键盘事件
   */
  const onLadderKey = (e: React.KeyboardEvent): void => {
    if (ladder.length === 0) return;
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.min(ladder.length - 1, Math.max(0, step + delta));
    const item = ladder[next];
    if (item !== undefined && item.value !== reasoning) onReasoningChange(item.value);
  };

  return (
    <div
      className="mp"
      title={providerLabel !== undefined && providerLabel !== '' ? t('模型与推理强度 · {name}', { name: providerLabel }) : t('模型与推理强度')}
      role="button"
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={t('选择模型与推理强度')}
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      <span className="mp-ico">{icon('brain', { size: 14 })}</span>
      {/* 标签 = 模型 +（强度）：两者本来就是同一个决定的两半，把强度也摆在触发按钮上，
          用户不必为了确认"现在是什么强度"点开弹窗。强度为空（该厂商无档位）时只显示模型，
          不留多余空格或分隔符 —— 见下方 label 的构造。 */}
      <span className="mp-label">{label}</span>
      {reasoningLabel !== '' ? <span className="mp-sub">{reasoningLabel}</span> : null}
      <span className="mp-caret">▾</span>
      {open ? (
        <div className="mp-menu" onClick={stopBubble}>
          <div className="mp-head">
            <span className="mp-head-title">{t('模型')}</span>
            {providerLabel !== undefined && providerLabel !== '' ? (
              <span className="mp-head-sub">{providerLabel}</span>
            ) : null}
          </div>
          <div className="mp-list" role="listbox" aria-label={t('可用模型')}>
            {models.map((m) => (
              <div
                key={m}
                className={'mp-item' + (m === model ? ' active' : '')}
                role="option"
                aria-selected={m === model ? 'true' : 'false'}
                onClick={() => {
                  onModelChange(m);
                  setOpen(false);
                }}
              >
                <span className="mp-item-name">{m}</span>
                {m === model ? <span className="mp-item-mark">{t('当前')}</span> : null}
              </div>
            ))}
          </div>

          {hasLadder ? (
            <>
              <div className="mp-sep" />
              <div className="mp-head">
                <span className="mp-head-title">{t('推理强度')}</span>
                <span className="mp-head-value">
                  {currentLabel}
                  {currentUnsupported ? <span className="mp-warn">{t(' · 该模型不支持')}</span> : null}
                </span>
              </div>
              <div
                className="mp-ladder"
                role="radiogroup"
                aria-label={t('推理强度')}
                onKeyDown={onLadderKey}
                tabIndex={0}
              >
                {ladder.map((o, i) => {
                  const isCurrent = o.value === reasoning;
                  // 不支持的档位不参与"填充比例"：它只表示"当前值在这"，不代表强度到顶。
                  const on = o.unsupported !== true && i <= step;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={
                        'mp-step' +
                        (on ? ' on' : '') +
                        (isCurrent ? ' current' : '') +
                        (o.unsupported === true ? ' unsupported' : '')
                      }
                      role="radio"
                      aria-checked={isCurrent ? 'true' : 'false'}
                      // 每段都可单独点选：进度条同时是"刻度"与"目标"
                      aria-label={
                        o.unsupported === true
                          ? t('推理强度 {name}（当前值，该模型不支持）', { name: o.label })
                          : t('推理强度 {name}', { name: o.label })
                      }
                      title={
                        o.unsupported === true
                          ? t('{name} · 该模型不支持这一档，点选其它档位即可切换', { name: o.label })
                          : o.label
                      }
                      onClick={() => onReasoningChange(o.value)}
                    >
                      <span className="mp-step-fill" />
                      <span className="mp-step-name">{o.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
