import { join } from 'node:path';
import type { SessionEvent } from '../ports/event.js';
import type { StoragePort } from '../ports/storage.js';
import type { WorkspaceSnapshotPort } from '../ports/workspaceSnapshot.js';
import { readSnapshotFile, writeSnapshotFile } from '../adapters/workspace/gitWorkspaceSnapshot.js';

/** 检查点元信息。 */
export interface CheckpointMeta {
  readonly label: string;
  readonly ts: string;
  readonly eventCount: number;
  /** 是否包含文件级快照（可用于代码回滚）。 */
  readonly hasFileSnapshot: boolean;
}

/** 检查点管理器选项。 */
export interface CheckpointOptions {
  /** 工作区快照端口（注入后检查点具备文件级回滚能力）。 */
  readonly snapshotter?: WorkspaceSnapshotPort;
  /** 工作区根（供文件快照定位）。 */
  readonly workspaceRoot?: string;
  /** 文件快照持久化目录（默认 `<workspaceRoot>/.omni-checkpoints`）。 */
  readonly stateDir?: string;
}

/** 索引键前缀：用于在该 session 下登记全部检查点 meta（StoragePort 无 list，故自管索引）。 */
const INDEX_PREFIX = 'checkpoint_index:';
/** 检查点事件键前缀：以合成 sessionId 作为独立 key 落盘事件。 */
const CK_PREFIX = 'checkpoint:';

function indexKey(sessionId: string): string {
  return `${INDEX_PREFIX}${sessionId}`;
}

function checkpointKey(sessionId: string, label: string): string {
  return `${CK_PREFIX}${sessionId}:${label}`;
}

/**
 * 会话检查点管理器：把当前事件日志快照，之后可回滚（Escape 式安全网）。
 *
 * StoragePort 仅暴露 `save(sessionId, events)` / `load(sessionId)`，且按 sessionId 寻址，
 * 因此这里用合成 key 把检查点事件与索引分别存为独立"会话"，从而不污染主会话日志。
 *
 * 若注入 `snapshotter` + `workspaceRoot`，则额外捕获工作区文件快照，回滚时**同时回滚对话与代码**
 * （对齐 Claude Code /rewind），而非仅回滚事件流。
 */
export class CheckpointManager {
  private readonly snapshotter?: WorkspaceSnapshotPort;
  private readonly workspaceRoot?: string;
  private readonly stateDir?: string;

  public constructor(
    private readonly storage: StoragePort,
    options: CheckpointOptions = {},
  ) {
    this.snapshotter = options.snapshotter;
    this.workspaceRoot = options.workspaceRoot;
    this.stateDir = options.stateDir;
  }

  /** 文件快照落盘路径。 */
  private fileSnapshotPath(sessionId: string, label: string): string {
    const base = this.stateDir ?? join(this.workspaceRoot ?? process.cwd(), '.omni-checkpoints');
    return join(base, sessionId, `${label}.files.json`);
  }

  /** 为当前 session 打快照；返回 meta。已存在同 label 则覆盖。 */
  public async snapshot(sessionId: string, label: string): Promise<CheckpointMeta> {
    const events = await this.storage.load(sessionId);
    const ts = new Date().toISOString();
    const hasFileSnapshot = await this.snapshotFiles(sessionId, label);
    const meta: CheckpointMeta = {
      label,
      ts,
      eventCount: events.length,
      hasFileSnapshot,
    };
    await this.storage.save(checkpointKey(sessionId, label), events);
    const index = await this.loadIndex(sessionId);
    const next = index.filter((m) => m.label !== label).concat(meta);
    await this.saveIndex(sessionId, next);
    return meta;
  }

  /** 捕获并落盘工作区文件快照；无 snapshotter/workspaceRoot 时返回 false。 */
  private async snapshotFiles(sessionId: string, label: string): Promise<boolean> {
    if (this.snapshotter === undefined || this.workspaceRoot === undefined) {
      return false;
    }
    try {
      const snapshot = await this.snapshotter.capture(this.workspaceRoot);
      await writeSnapshotFile(this.fileSnapshotPath(sessionId, label), snapshot);
      return true;
    } catch (error) {
      // 文件快照失败时降级为纯事件检查点，但显式标记无文件快照（不谎称已捕获）。
      console.warn(`[checkpoint] 文件快照失败，仅保留事件检查点: ${this.messageOf(error)}`);
      return false;
    }
  }

  /** 列出该 session 的全部检查点（按 ts 升序）。 */
  public async list(sessionId: string): Promise<CheckpointMeta[]> {
    const index = await this.loadIndex(sessionId);
    return [...index].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  /**
   * 回滚到选中快照：把其 events 覆盖写回主 session storage（"回到该点"）。
   * 若该检查点含文件快照，则**同时回滚工作区代码**（手术式还原）。
   * 无快照时抛 `Error('无可用检查点')`（fail-closed，不静默跳过）。
   * 不传 label 时回滚到最近一次快照；指定 label 不存在亦 fail-closed 抛错。
   */
  public async rollback(sessionId: string, label?: string): Promise<CheckpointMeta> {
    const index = await this.loadIndex(sessionId);
    if (index.length === 0) {
      throw new Error('无可用检查点');
    }
    let target: CheckpointMeta;
    if (label === undefined) {
      target = [...index].sort((a, b) =>
        a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
      )[0] as CheckpointMeta;
    } else {
      const found = index.find((m) => m.label === label);
      if (found === undefined) {
        throw new Error(`无可用检查点: ${label}`);
      }
      target = found;
    }
    const events = await this.storage.load(checkpointKey(sessionId, target.label));
    await this.storage.save(sessionId, events);
    if (target.hasFileSnapshot && this.snapshotter !== undefined) {
      await this.restoreFiles(sessionId, target.label);
    }
    return target;
  }

  /** 还原文件快照（失败抛错，不掩盖代码回滚失败）。 */
  private async restoreFiles(sessionId: string, label: string): Promise<void> {
    const path = this.fileSnapshotPath(sessionId, label);
    const snapshot = await readSnapshotFile(path);
    await this.snapshotter!.restore(this.workspaceRoot ?? snapshot.root, snapshot);
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** 读取索引（无则返回空数组）。 */
  private async loadIndex(sessionId: string): Promise<CheckpointMeta[]> {
    const raw = await this.storage.load(indexKey(sessionId));
    if (raw.length === 0) {
      return [];
    }
    return raw as unknown as CheckpointMeta[];
  }

  /** 写入索引（meta 数组借 StoragePort 的 events 通道落盘）。 */
  private async saveIndex(sessionId: string, meta: readonly CheckpointMeta[]): Promise<void> {
    await this.storage.save(indexKey(sessionId), meta as unknown as readonly SessionEvent[]);
  }
}
