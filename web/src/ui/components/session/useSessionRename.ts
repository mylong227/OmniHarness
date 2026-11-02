// 会话行内重命名态（从 SessionPanel 抽出）：只持有编辑态，提交交给宿主回调。
//
// 与删除确认态互斥（进入一种即清掉另一种），互斥关系由宿主在组合处接线——本 hook 只做
// 「预填 / 取消 / 提交」三件事，保持零业务知识。

import * as React from 'react';
import type { SessionEntry } from '../../shared.ts';

/** 行内重命名态与动作。 */
export interface SessionRenameApi {
  /** 正在行内重命名的会话 id（null 表示无）。 */
  readonly renamingId: string | null;
  /** 行内重命名输入框当前值。 */
  readonly renameValue: string;
  /** 进入行内重命名（预填当前标签）。 */
  readonly start: (s: SessionEntry) => void;
  /** 输入框变更。 */
  readonly setValue: (value: string) => void;
  /** 提交（空标题也照常提交，由服务端清除自定义标题）。 */
  readonly commit: (id: string) => Promise<void>;
  /** 取消行内重命名。 */
  readonly cancel: () => void;
}

/**
 * 行内重命名态。
 * @param onRename 宿主的重命名回调（会话 id + 新标题）
 * @returns 行内重命名态与动作
 */
export function useSessionRename(
  onRename: (id: string, title: string) => void | Promise<void>,
): SessionRenameApi {
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState<string>('');

  /** 进入行内重命名：预填当前标签。 */
  const start = (s: SessionEntry): void => {
    setRenamingId(s.id);
    setRenameValue(s.label || s.id);
  };

  /** 取消行内重命名。 */
  const cancel = (): void => {
    setRenamingId(null);
    setRenameValue('');
  };

  /** 提交行内重命名（先退出编辑态，再等宿主落地）。 */
  const commit = async (id: string): Promise<void> => {
    const title = renameValue;
    setRenamingId(null);
    setRenameValue('');
    await onRename(id, title);
  };

  return { renamingId, renameValue, start, setValue: setRenameValue, commit, cancel };
}
