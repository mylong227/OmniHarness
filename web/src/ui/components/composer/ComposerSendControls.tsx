// busy / 空闲两态的发送区按钮：busy 时是「发送+停止」，空闲时是「发送」。
//
// 单独成组件是为了让 Composer 的工具条（Composer.tsx 内）与 Composer 本体都保持薄；
// 文案（图标 / aria-label / title）全部来自 composerLabels.busySendOf，按聊天模式区分。

import { t } from '../../i18n/i18n.ts';
import { busySendOf } from './composerLabels.ts';

/** 发送区按钮的入参。 */
export interface ComposerSendControlsProps {
  /** 是否有回合在跑（决定是「入队/插话 + 停止」还是单纯发送）。 */
  readonly busy: boolean | undefined;
  /** 当前聊天模式（决定 busy 态按钮语义）。 */
  readonly mode: 'queue' | 'steer' | undefined;
  /** 空闲态是否禁用发送（回合不可用时由上层传入）。 */
  readonly disabled: boolean | undefined;
  /** 发送 / 入队 / 插话（同一上抛，路由在 ComposerController）。 */
  readonly onSend: () => void;
  /** 停止在跑回合。 */
  readonly onStop: (() => void) | undefined;
}

/**
 * 发送区按钮：busy 态给「入队 / 插话」+ 停止，空闲态给发送。
 * @param props 组件入参
 * @returns 按钮节点（busy 时是两枚按钮的片段）
 */
export function ComposerSendControls(props: ComposerSendControlsProps): ReactElement {
  if (props.busy === true) {
    const busySend = busySendOf(props.mode);
    return (
      <>
        <button
          className="send round"
          aria-label={busySend.label}
          title={busySend.title}
          onClick={props.onSend}
        >
          {busySend.glyph}
        </button>
        <button
          className="stop round"
          aria-label={t('停止生成')}
          title={t('停止生成')}
          onClick={() => {
            props.onStop?.();
          }}
        >
          ■
        </button>
      </>
    );
  }
  return (
    <button
      className="send round"
      disabled={props.disabled}
      aria-label={t('发送任务')}
      title={t('发送（Enter）')}
      onClick={props.onSend}
    >
      ↑
    </button>
  );
}
