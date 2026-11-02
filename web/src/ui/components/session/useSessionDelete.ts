// 会话删除确认态（从 SessionPanel 抽出）：只持有确认态，删除交给宿主回调。
//
// 「先确认再删」是刻意保留的两步式（`删除…` → 行内「删除？」确认条）：误点删除会丢掉整段
// 会话存档，不可恢复。本 hook 只做确认态的开/关/提交，不碰业务。

import * as React from 'react';

/** 删除确认态与动作。 */
export interface SessionDeleteApi {
  /** 正在确认删除的会话 id（null 表示无）。 */
  readonly confirmDeleteId: string | null;
  /** 进入删除确认态。 */
  readonly ask: (id: string) => void;
  /** 取消删除确认态。 */
  readonly cancel: () => void;
  /** 提交删除。 */
  readonly commit: (id: string) => Promise<void>;
}

/**
 * 删除确认态。
 * @param onDelete 宿主的删除回调（会话 id）
 * @returns 删除确认态与动作
 */
export function useSessionDelete(onDelete: (id: string) => void | Promise<void>): SessionDeleteApi {
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);

  /** 进入删除确认态。 */
  const ask = (id: string): void => setConfirmDeleteId(id);

  /** 取消删除确认态。 */
  const cancel = (): void => setConfirmDeleteId(null);

  /** 提交删除（先退出确认态，再等宿主落地）。 */
  const commit = async (id: string): Promise<void> => {
    setConfirmDeleteId(null);
    await onDelete(id);
  };

  return { confirmDeleteId, ask, cancel, commit };
}
