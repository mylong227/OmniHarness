import { join } from 'node:path';
import type { SessionEvent } from '../ports/event.js';
import type { StoragePort } from '../ports/storage.js';
import type { WorkspaceSnapshotPort } from '../ports/workspaceSnapshot.js';
import { type CheckpointMeta, type CheckpointManagerPort } from '../ports/checkpointManager.js';
import { readSnapshotFile, writeSnapshotFile } from './snapshotFileIo.js';

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

/** 索引 key：检查点 meta 以合成"会话"形式借 StoragePort 存取。 */
function indexKey(sessionId: string): string {
  return `${INDEX_PREFIX}${sessionId}`;
}

/** 检查点事件 key：每个检查点的事件快照存为独立合成"会话"，不污染主日志。 */
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
export class CheckpointManager implements CheckpointManagerPort {
  /** 工作区快照端口（可选）：具备时检查点附带文件级快照，支持代码回滚。 */
  private readonly snapshotter?: WorkspaceSnapshotPort;
  /** 工作区根：文件快照的捕获与还原范围。 */
  private readonly workspaceRoot?: string;
  /** 文件快照落盘目录：缺省为 `<workspaceRoot>/.omni-checkpoints`。 */
  private readonly stateDir?: string;

  public constructor(
    /** 存储端口：检查点事件与索引都以合成 key 借其 events 通道落盘。 */
    private readonly storage: StoragePort,
    /** 可选配置：文件快照端口、工作区根与落盘目录。 */
    options: CheckpointOptions = {},
  ) {
    this.snapshotter = options.snapshotter;
    this.workspaceRoot = options.workspaceRoot;
    this.stateDir = options.stateDir;
  }

  /**
   * 文件快照落盘路径。
   * @param sessionId 检查点所属会话 ID。
   * @param label 检查点标签（同会话内唯一）。
   * @returns `<stateDir>/<sessionId>/<label>.files.json` 形式的绝对路径。
   */
  private fileSnapshotPath(sessionId: string, label: string): string {
    const base = this.stateDir ?? join(this.workspaceRoot ?? process.cwd(), '.omni-checkpoints');
    return join(base, sessionId, `${label}.files.json`);
  }

  /**
   * 为当前 session 打快照；返回 meta。已存在同 label 则覆盖。
   * @param sessionId 要打快照的会话 ID。
   * @param label 检查点标签（同 label 覆盖旧快照）。
   * @returns 本检查点的元信息（标签、时间、事件数、是否含文件快照）。
   */
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

  /**
   * 捕获并落盘工作区文件快照；无 snapshotter/workspaceRoot 时返回 false。
   * @param sessionId 检查点所属会话 ID（决定落盘子目录）。
   * @param label 检查点标签（决定落盘文件名）。
   * @returns 文件快照是否成功捕获（失败降级为纯事件检查点）。
   */
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

  /**
   * 列出该 session 的全部检查点（按 ts 升序）。
   * @param sessionId 目标会话 ID。
   * @returns 检查点 meta 数组（时间升序，供 UI 展示选择）。
   */
  public async list(sessionId: string): Promise<CheckpointMeta[]> {
    const index = await this.loadIndex(sessionId);
    return [...index].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  /**
   * 回滚到选中快照：把其 events 覆盖写回主 session storage（"回到该点"）。
   * 若该检查点含文件快照，则**同时回滚工作区代码**（手术式还原）。
   * 无快照时抛 `Error('无可用检查点')`（fail-closed，不静默跳过）。
   * 不传 label 时回滚到最近一次快照；指定 label 不存在亦 fail-closed 抛错。
   * @param sessionId 要回滚的会话 ID。
   * @param label 目标检查点标签；缺省回滚到最近一次快照。
   * @returns 被回滚到的检查点 meta。
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

  /**
   * 还原文件快照（失败抛错，不掩盖代码回滚失败）。
   * @param sessionId 检查点所属会话 ID（定位快照文件）。
   * @param label 检查点标签（定位快照文件）。
   
 * @returns 无返回值。
*/
  private async restoreFiles(sessionId: string, label: string): Promise<void> {
    const path = this.fileSnapshotPath(sessionId, label);
    const snapshot = await readSnapshotFile(path);
    await this.snapshotter!.restore(this.workspaceRoot ?? snapshot.root, snapshot);
  }

  /**
   * 提取错误消息。
   * @param error 任意抛出值。
   * @returns Error 实例取 message，其余 String 化。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 读取索引（无则返回空数组）。
   * @param sessionId 目标会话 ID。
   * @returns 该会话全部检查点 meta（StoragePort 无 list，故以索引数组自管）。
   */
  private async loadIndex(sessionId: string): Promise<CheckpointMeta[]> {
    const raw = await this.storage.load(indexKey(sessionId));
    if (raw.length === 0) {
      return [];
    }
    return raw as unknown as CheckpointMeta[];
  }

  /**
   * 写入索引（meta 数组借 StoragePort 的 events 通道落盘）。
   * @param sessionId 目标会话 ID。
   * @param meta 要写入的全部检查点 meta（全量覆盖）。
   
 * @returns 无返回值。
*/
  private async saveIndex(sessionId: string, meta: readonly CheckpointMeta[]): Promise<void> {
    await this.storage.save(indexKey(sessionId), meta as unknown as readonly SessionEvent[]);
  }
}
