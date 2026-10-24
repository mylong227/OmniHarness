import { join, resolve, sep } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import type { SessionEvent } from '../ports/runtime/event.ts';
import type { StoragePort } from '../ports/memory/storage.ts';
import type { WorkspaceSnapshotPort } from '../ports/tool/workspaceSnapshot.ts';
import {
  type CheckpointMeta,
  type CheckpointManagerPort,
} from '../ports/runtime/checkpointManager.ts';
import type { LiveSessionRewindPort } from '../ports/runtime/liveSessionRewindPort.ts';
import { SnapshotFileIo } from './snapshotFileIo.ts';
import { LiveSessionRewindRegistry } from './liveSessionRewindRegistry.ts';
import { log } from '../util/logger.ts';

/** 检查点管理器选项。 */
export interface CheckpointOptions {
  /** 工作区快照端口（注入后检查点具备文件级回滚能力）。 */
  readonly snapshotter?: WorkspaceSnapshotPort;
  /** 工作区根（供文件快照定位）。 */
  readonly workspaceRoot?: string;
  /** 文件快照持久化目录（默认 `<workspaceRoot>/.omni-checkpoints`）。 */
  readonly stateDir?: string;
  /**
   * 每会话保留的文件快照个数（缺省 {@link CheckpointManager.DEFAULT_MAX_FILE_SNAPSHOTS}）。
   *
   * 只在注入 `snapshotter` 的显式检查点路径生效；纯事件检查点（自动检查点）不触发文件清理，
   * 避免自动检查点把用户显式打的文件快照淘汰掉。
   */
  readonly maxFileSnapshots?: number;
  /** 每会话文件快照总字节上限（缺省 {@link CheckpointManager.DEFAULT_MAX_FILE_SNAPSHOT_BYTES}）。 */
  readonly maxFileSnapshotBytes?: number;
  /**
   * 在跑会话的事件流回卷端口（缺省取进程级登记表 `LiveSessionRewindRegistry`）。
   *
   * 为什么必须有（2026-10-03 登记的 P1 缺陷）：回滚只写磁盘时，运行中会话的内存日志仍是全量，
   * 下一步 write-behind 落盘会把回滚**原样覆盖**——用户看到「已回滚」而历史没变。回卷端口把
   * 内存事实源与派生态（检索索引 / 事件持久化器）一并对齐。
   */
  readonly rewind?: LiveSessionRewindPort | undefined;
}

/** 索引键前缀：用于在该 session 下登记全部检查点 meta（StoragePort 无 list，故自管索引）。 */
const INDEX_PREFIX = 'checkpoint_index:';
/** 检查点事件键前缀：以合成 sessionId 作为独立 key 落盘事件。 */
const CK_PREFIX = 'checkpoint:';

/**
 * 标签/会话 id 白名单（**fail-closed**）：只允许字母数字与 `_`/`-`，长度 1–64。
 *
 * 为什么必须校验（2026-09-22 修，审计 P2）：`fileSnapshotPath` 用
 * `join(base, sessionId, `${label}.files.json`)` 直接拼路径，而 `label` 来自**模型可控的工具参数**
 * ⇒ `checkpoint{label:"../../../../x/y"}` 可把「含工作区文件内容的快照 JSON」写到工作区外任意可写路径，
 * `rollback` 取路径同源，配合快照还原构成越界读写。白名单 `..`、`/`、`\` 一律被拒。
 */
const SAFE_CHECKPOINT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 索引 key：检查点 meta 以合成"会话"形式借 StoragePort 存取。 */

/** 检查点事件 key：每个检查点的事件快照存为独立合成"会话"，不污染主日志。 */

/**
 * 会话检查点管理器：把当前事件日志快照，之后可回滚（Escape 式安全网）。
 *
 * StoragePort 仅暴露 `save(sessionId, events)` / `load(sessionId)`，且按 sessionId 寻址，
 * 因此这里用合成 key 把检查点事件与索引分别存为独立"会话"，从而不污染主会话日志。
 *
 * 若注入 `snapshotter` + `workspaceRoot`，则额外捕获工作区文件快照，回滚时**同时回滚对话与代码**
 * （对话 + 代码双回滚），而非仅回滚事件流。
 */
export class CheckpointManager implements CheckpointManagerPort {
  /** 每会话默认保留 20 个文件快照。 */
  public static readonly DEFAULT_MAX_FILE_SNAPSHOTS = 20;

  /** 每会话默认文件快照总预算：256 MiB。 */
  public static readonly DEFAULT_MAX_FILE_SNAPSHOT_BYTES = 256 * 1024 * 1024;

  /** 工作区快照端口（可选）：具备时检查点附带文件级快照，支持代码回滚。 */
  private readonly snapshotter?: WorkspaceSnapshotPort | undefined;
  /** 工作区根：文件快照的捕获与还原范围。 */
  private readonly workspaceRoot?: string | undefined;
  /** 文件快照落盘目录：缺省为 `<workspaceRoot>/.omni-checkpoints`。 */
  private readonly stateDir?: string | undefined;
  /** 每会话文件快照保留个数（≥1）。 */
  private readonly maxFileSnapshots: number;
  /** 每会话文件快照总字节上限（≥1）。 */
  private readonly maxFileSnapshotBytes: number;
  /** 在跑会话回卷端口：缺省取进程级登记表（见 `CheckpointOptions.rewind`）。 */
  private readonly rewind: LiveSessionRewindPort;

  public constructor(
    /** 存储端口：检查点事件与索引都以合成 key 借其 events 通道落盘。 */
    private readonly storage: StoragePort,
    /** 可选配置：文件快照端口、工作区根与落盘目录。 */
    options: CheckpointOptions = {},
  ) {
    this.snapshotter = options.snapshotter;
    this.workspaceRoot = options.workspaceRoot;
    this.stateDir = options.stateDir;
    this.maxFileSnapshots = CheckpointManager.positiveOr(
      options.maxFileSnapshots,
      CheckpointManager.DEFAULT_MAX_FILE_SNAPSHOTS,
    );
    this.maxFileSnapshotBytes = CheckpointManager.positiveOr(
      options.maxFileSnapshotBytes,
      CheckpointManager.DEFAULT_MAX_FILE_SNAPSHOT_BYTES,
    );
    this.rewind = options.rewind ?? LiveSessionRewindRegistry.sharedRegistry();
  }

  /**
   * 文件快照落盘路径（含**越界断言**）。
   * @param sessionId 检查点所属会话 ID（白名单校验）。
   * @param label 检查点标签（白名单校验）。
   * @returns `<stateDir>/<sessionId>/<label>.files.json` 形式的绝对路径。
   * @throws Error 标识非法或结果路径逃出 stateDir 时抛出（fail-closed）
   */
  private fileSnapshotPath(sessionId: string, label: string): string {
    CheckpointManager.assertSafeCheckpointId(sessionId, 'sessionId');
    CheckpointManager.assertSafeCheckpointId(label, 'label');
    const base = resolve(
      this.stateDir ?? join(this.workspaceRoot ?? process.cwd(), '.omni-checkpoints'),
    );
    const target = resolve(join(base, sessionId, `${label}.files.json`));
    // 双保险：即便白名单未来被放宽，也断言最终路径仍在 base 之内（防「词法在内、真实在外」）。
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`检查点路径越界：${target}`);
    }
    return target;
  }

  /**
   * 为当前 session 打快照；返回 meta。已存在同 label 则覆盖。
   * @param sessionId 要打快照的会话 ID。
   * @param label 检查点标签（同 label 覆盖旧快照）。
   * @returns 本检查点的元信息（标签、时间、事件数、是否含文件快照）。
   */
  public async snapshot(sessionId: string, label: string): Promise<CheckpointMeta> {
    // 入口即校验（fail-closed）：不能只在 `fileSnapshotPath` 里校验——那条路径仅在注入了
    // workspaceSnapshot 时才走到，纯事件检查点会**跳过校验**（2026-09-22 由回归测试暴露）。
    // 非法标识还会被写进 storage 的合成 key（`checkpoint:<sid>:<label>`），故此处必须拦。
    CheckpointManager.assertSafeCheckpointId(sessionId, 'sessionId');
    CheckpointManager.assertSafeCheckpointId(label, 'label');
    const events = await this.storage.load(sessionId);
    const ts = new Date().toISOString();
    const hasFileSnapshot = await this.snapshotFiles(sessionId, label);
    const meta: CheckpointMeta = {
      label,
      ts,
      eventCount: events.length,
      hasFileSnapshot,
    };
    await this.storage.save(CheckpointManager.checkpointKey(sessionId, label), events);
    const index = await this.loadIndex(sessionId);
    const next = index.filter((m) => m.label !== label).concat(meta);
    const kept = await this.pruneFileSnapshots(sessionId, next);
    await this.saveIndex(sessionId, kept);
    return meta;
  }

  /**
   * 按「每会话文件快照个数 + 总字节」淘汰最旧的文件快照。
   *
   * 为什么只在有 `snapshotter` 时生效：自动检查点（无 snapshotter、纯事件）也会调用
   * `snapshot()`；若它来清理文件，会把用户显式打的文件快照一并删掉。这里只让显式检查点
   * 路径承担保留策略，自动检查点只写自己的事件索引。
   *
   * 淘汰的是**文件快照**与索引项；事件载荷（`checkpoint:<sid>:<label>`）留在存储里
   * （StoragePort 没有 delete 通道），体量小，不影响正确性。文件删除失败只告警并保留索引，
   * 下次再试，不静默丢历史。
   * @param sessionId 会话 ID。
   * @param meta 待写入的完整索引。
   * @returns 保留的索引（已按时间升序）。
   */
  private async pruneFileSnapshots(
    sessionId: string,
    meta: readonly CheckpointMeta[],
  ): Promise<CheckpointMeta[]> {
    if (this.snapshotter === undefined || meta.length === 0) {
      return [...meta];
    }
    const kept = [...meta].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const sizes = new Map<string, number>();
    let total = 0;
    for (const item of kept) {
      const size = await this.fileSnapshotSize(sessionId, item);
      sizes.set(item.label, size);
      total += size;
    }
    const dropped: CheckpointMeta[] = [];
    while (kept.length > this.maxFileSnapshots) {
      const oldest = kept.shift();
      if (oldest === undefined) break;
      dropped.push(oldest);
      total -= sizes.get(oldest.label) ?? 0;
    }
    // 至少保留最新一个：即使单份就超预算，也不把当前检查点删掉（否则用户刚打的点立即消失）。
    while (total > this.maxFileSnapshotBytes && kept.length > 1) {
      const oldest = kept.shift();
      if (oldest === undefined) break;
      dropped.push(oldest);
      total -= sizes.get(oldest.label) ?? 0;
    }
    for (const item of dropped) {
      if (!item.hasFileSnapshot) continue;
      try {
        await rm(this.fileSnapshotPath(sessionId, item.label), { force: true });
      } catch (error) {
        log.warn('checkpoint.prune.file_failed', {
          sessionId,
          label: item.label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return kept;
  }

  /**
   * 文件快照的字节数（无文件/读不到按 0）。
   * @param sessionId 会话 ID。
   * @param meta 检查点元信息。
   * @returns 字节数。
   */
  private async fileSnapshotSize(sessionId: string, meta: CheckpointMeta): Promise<number> {
    if (!meta.hasFileSnapshot) return 0;
    try {
      return (await stat(this.fileSnapshotPath(sessionId, meta.label))).size;
    } catch {
      return 0;
    }
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
      await SnapshotFileIo.writeSnapshotFile(this.fileSnapshotPath(sessionId, label), snapshot);
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
    // 入口即校验（fail-closed）——理由同 `snapshot()`：非法标识既会拼进 storage 合成 key，
    // 也会拼进文件快照路径（label 是模型可控参数）。
    CheckpointManager.assertSafeCheckpointId(sessionId, 'sessionId');
    if (label !== undefined) {
      CheckpointManager.assertSafeCheckpointId(label, 'label');
    }
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
    const events = await this.storage.load(
      CheckpointManager.checkpointKey(sessionId, target.label),
    );
    // fail-closed（2026-10-03 修）：索引里有该检查点、但载荷丢失/损坏时，绝不能用残缺快照
    // 覆盖主会话日志——三个存储后端对缺失 key 都返回 []，jsonl 对坏行跳过并告警，历史上这条
    // 路径会把全部会话历史无声清空（类文档宣称 fail-closed，实际只挡了「索引里没有」）。
    // 判据按 meta.eventCount 分档：eventCount>0 而载得 0 条 = 载荷丢失；条数不一致 = 半截载荷。
    // eventCount===0 的纯文件快照（文件回滚用途，事件为空是合法形态）不受影响。
    if (events.length !== target.eventCount) {
      throw new Error(
        `检查点载荷缺失或损坏: ${target.label}（索引记录 ${String(target.eventCount)} 条事件，` +
          `实际载得 ${String(events.length)} 条，拒绝用残缺快照覆盖主会话）`,
      );
    }
    await this.storage.save(sessionId, events);
    // 内存侧对齐（2026-10-03 修 P1）：**必须**在磁盘写回之后紧接执行，否则运行中会话的
    // write-behind 会把刚写好的回滚覆盖回全量（旧行为：用户看到「已回滚」而历史没变）。
    // 未命中在跑会话（false）是合法形态——离线/服务端回滚本就没有内存态要同步，不视为失败。
    await this.rewind.rewind(sessionId, events.length);
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
    const snapshot = await SnapshotFileIo.readSnapshotFile(path);
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
    const raw = await this.storage.load(CheckpointManager.indexKey(sessionId));
    if (raw.length === 0) {
      return [];
    }
    // StoragePort 以 SessionEvent 通道承载：读出后按 payload 结构校验还原（fail-closed 丢弃异形项）。
    return raw
      .map((e) => e.payload)
      .filter(
        (p): p is CheckpointMeta =>
          typeof p === 'object' && p !== null && 'label' in p && 'ts' in p,
      );
  }

  /**
   * 写入索引（meta 数组借 StoragePort 的 events 通道落盘）。
   * @param sessionId 目标会话 ID。
   * @param meta 要写入的全部检查点 meta（全量覆盖）。
   
   * @returns 无返回值。
   */
  private async saveIndex(sessionId: string, meta: readonly CheckpointMeta[]): Promise<void> {
    // 写入真实 SessionEvent 包装（payload 携带 meta），读取端按 payload 结构校验还原。
    const events: readonly SessionEvent[] = meta.map((m, i) => ({
      id: `ckpt-index-${i}`,
      type: 'system',
      sessionId,
      timestamp: m.ts,
      payload: m,
    }));
    await this.storage.save(CheckpointManager.indexKey(sessionId), events);
  }
  /**
   * indexKey (internal helper hoisted into CheckpointManager).
   * @param {string} sessionId
   * @returns {string}
   */
  private static indexKey(sessionId: string): string {
    return `${INDEX_PREFIX}${sessionId}`;
  }
  /**
   * checkpointKey (internal helper hoisted into CheckpointManager).
   * @param {string} sessionId
   * @param {string} label
   * @returns {string}
   */
  private static checkpointKey(sessionId: string, label: string): string {
    return `${CK_PREFIX}${sessionId}:${label}`;
  }

  /**
   * 校验检查点标识（标签或会话 id）。
   * @param value 待校验值
   * @param field 出错信息中的字段名
   * @throws Error 不符合白名单时抛出（调用方按 fail-closed 返回失败）
   */
  public static assertSafeCheckpointId(value: string, field: string): void {
    if (!SAFE_CHECKPOINT_ID.test(value)) {
      throw new Error(
        `${field} 非法（仅允许字母数字与 _ -，长度 1–64）：${value.replace(/[\r\n]/g, ' ').slice(0, 80)}`,
      );
    }
  }

  /** 归一化正数选项（非法/非正回落默认）。
   * @param value 输入值。
   * @param fallback 默认值。
   * @returns 正数。
   */
  private static positiveOr(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  }
}
