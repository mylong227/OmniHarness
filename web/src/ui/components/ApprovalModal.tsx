// 工具审批弹窗：SSE 推送 approval.request 时在 App 层置位，本组件负责展示与响应。
//
// a11y（D1）：role="dialog" + aria-modal + aria-labelledby/describedby；打开时把焦点交给
// 「拒绝」——审批是安全闸门，默认落点应是权限最小的那个选项，而不是最顺手的那个。
// **刻意不做「Esc = 拒绝」**：静默拒绝会让等待中的模型收到一个用户从未做出的决定
// （与 D4 的对话框同理，决策不可静默产生）——因此 antd Modal 的 keyboard/mask.closable/closable
// 三条关闭路径全部关死，唯一出口是三枚决策按钮。
//
// W2（2026-10-29）：外壳换 antd Modal——遮罩 / 层级 / 开关动画由 antd 承担。
// **Tab 圈定仍是自研**（antd v6 的 dialog 没有 trap，实测合成/真实 Tab 都会圈出弹窗）：
// 经 wrapProps 挂在包裹层（等价原 .overlay 的位置，事件从按钮冒泡上来），循环序与原实现一致
// [始终允许, 拒绝, 允许, 更改权限]；approvalModalFocus 判据原样作为验收标尺。
// 「拒绝」保持 danger 非 primary：默认落点在权限最小的选项，视觉上也不该怂恿放行。
// 纯展示组件：决策通过回调上抛，自身不保存业务状态。

import * as React from 'react';
// 子路径导入（不走 barrel，理由见 vite.config.ts「分块改造」注释）。
import Button from 'antd/es/button';
import Modal from 'antd/es/modal';
import { jsonView } from '../format.ts';
import { icon } from '../models/Icon.ts';
import { toolVerb } from '../textUtils.ts';
import type { ApprovalRequest } from '../../types/models.ts';
import { t } from '../i18n/i18n.ts';

/** ApprovalModal 组件的入参。 */
export interface ApprovalModalProps {
  /** 待审批请求；为 null 时不弹。 */
  approval: ApprovalRequest | null;
  /** 用户决策：允许 / 拒绝 + 是否始终允许。 */
  onRespond: (decision: 'allow' | 'deny', always: boolean) => void;
  /** 点击「更改权限」：让外层打开权限档位选择器（App 置位设置页 / 派发聚焦）。 */
  onChangePermission?: () => void;
}

/**
 * 审批动作区（始终允许 / 拒绝 / 允许 / 更改权限）。
 * @param props 按钮引用与回调。
 * @returns 动作区节点。
 */
function ApprovalActions(props: {
  alwaysRef: React.RefObject<HTMLButtonElement | null>;
  denyRef: React.RefObject<HTMLButtonElement | null>;
  allowRef: React.RefObject<HTMLButtonElement | null>;
  changePermRef: React.RefObject<HTMLButtonElement | null>;
  onRespond: (decision: 'allow' | 'deny', always: boolean) => void;
  onChangePermission?: (() => void) | undefined;
}): ReactElement {
  const { alwaysRef, denyRef, allowRef, changePermRef, onRespond, onChangePermission } = props;
  return (
    <>
      <div className="actions">
        <Button
          className="always"
          ref={(el: HTMLButtonElement | null) => {
            alwaysRef.current = el;
          }}
          onClick={() => onRespond('allow', true)}
        >
          {t('始终允许')}
        </Button>
        <Button
          className="deny"
          danger
          ref={(el: HTMLButtonElement | null) => {
            denyRef.current = el;
          }}
          onClick={() => onRespond('deny', false)}
        >
          {t('拒绝')}
        </Button>
        <Button
          type="primary"
          className="allow"
          ref={(el: HTMLButtonElement | null) => {
            allowRef.current = el;
          }}
          onClick={() => onRespond('allow', false)}
        >
          {t('允许')}
        </Button>
      </div>
      {onChangePermission ? (
        <div className="approval-change-perm">
          <Button
            type="link"
            className="link"
            ref={(el: HTMLButtonElement | null) => {
              changePermRef.current = el;
            }}
            onClick={onChangePermission}
          >
            {t('更改权限')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * 工具审批弹窗：展示工具名 / 目标 / 参数，并给出「始终允许 / 拒绝 / 允许」三档决策。
 * @param props 组件入参
 * @returns 审批弹窗节点（无待审批时不渲染内容）
 */
export function ApprovalModal(props: ApprovalModalProps): ReactElement {
  const { approval, onRespond, onChangePermission } = props;
  /** 「拒绝」按钮引用（默认焦点；安全闸门的落点口径见文件头）。 */
  const denyRef = React.useRef<HTMLButtonElement | null>(null);
  /** 「始终允许」按钮引用（antd trap 的 DOM 顺序锚）。 */
  const alwaysRef = React.useRef<HTMLButtonElement | null>(null);
  /** 「允许」按钮引用。 */
  const allowRef = React.useRef<HTMLButtonElement | null>(null);
  /** 「更改权限」按钮引用（此前漏登记 ⇒ 键盘用户永远到不了它，判据钉死）。 */
  const changePermRef = React.useRef<HTMLButtonElement | null>(null);
  /** 已为其设置过焦点默认值的请求（避免同一请求重复抢焦点）。 */
  const focusedForRef = React.useRef<ApprovalRequest | null>(null);

  // 新请求到来 / 挂载时设置默认焦点（零 DOM 环境下 ref 为空则静默跳过）。
  React.useEffect(() => {
    if (!approval) {
      focusedForRef.current = null;
      return;
    }
    if (approval === focusedForRef.current) return;
    focusedForRef.current = approval;
    denyRef.current?.focus();
  }, [approval]);

  /**
   * Tab 在弹窗内可聚焦按钮间循环（简单焦点圈定；antd v6 dialog 无 trap，见文件头）。
   * @param e 键盘事件
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const list = [alwaysRef.current, denyRef.current, allowRef.current, changePermRef.current].filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    if (list.length === 0) return;
    e.preventDefault();
    const active = list.findIndex((el) => el === document.activeElement);
    const from = active < 0 ? (e.shiftKey ? 0 : -1) : active;
    list[(from + (e.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
  };

  const args = approval?.args != null ? jsonView(approval.args) : '';
  const toolLabel = approval?.toolName ? t(toolVerb(approval.toolName)) : '?';
  return (
    <Modal
      open={approval !== null}
      title={
        <span id="ap-title">
          {icon('shield-alert', { size: 16 })} {t('工具审批请求')}
        </span>
      }
      footer={
        approval === null ? null : (
          <ApprovalActions
            alwaysRef={alwaysRef}
            denyRef={denyRef}
            allowRef={allowRef}
            changePermRef={changePermRef}
            onRespond={onRespond}
            {...(onChangePermission !== undefined ? { onChangePermission } : {})}
          />
        )
      }
      closable={false}
      keyboard={false}
      // antd v6：`maskClosable` 已弃用，改 `mask.closable`（遮罩仍渲染，只是点不关）。
      mask={{ closable: false }}
      width={420}
      className="approval-modal"
      destroyOnHidden
      wrapProps={{ onKeyDown }}
    >
      <div className="meta">{t('工具：{name}', { name: toolLabel })}</div>
      <div className="meta">{t('目标：{name}', { name: approval?.target || '—' })}</div>
      {/* antd Modal 不会把自定义 id 接进 aria-describedby——给参数区一个显式 aria-label，
          保证读屏仍能念到参数（原 aria-describedby=ap-desc 的等价替代）。 */}
      <pre id="ap-desc" aria-label={t('工具参数')}>
        {args}
      </pre>
    </Modal>
  );
}
