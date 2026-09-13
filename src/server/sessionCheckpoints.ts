import type { StoragePort } from '../ports/memory/storage.js';
import { CheckpointManager } from '../core/checkpointManager.js';
import { GitWorkspaceSnapshot } from '../adapters/workspace/gitWorkspaceSnapshot.js';

/** SessionCheckpoints 构造选项。 */
export interface SessionCheckpointsOptions {
  /** 会话存储端口（检查点索引落在此，复用会话同一份存储）。 */
  readonly storage: StoragePort;
  /** 工作区根（检查点文件快照还原用；缺省回退进程当前目录）。 */
  readonly workspaceRoot?: string;
}

/**
 * 会话检查点领域服务（对标 Codex「回滚到检查点」）：列出 / 创建 / 回滚（对话 + 代码）。
 *
 * 惰性构造 `CheckpointManager`：复用会话 StoragePort 存索引 + Git 文件快照适配器还原代码，
 * 每次调用重建（管理器无长驻状态，避免跨会话串味）。
 */
export class SessionCheckpoints {
  /**
   * @param options 已解析配置与工作区根。
   */
  public constructor(private readonly options: SessionCheckpointsOptions) {}

  /**
   * 列出某会话的全部检查点。
   * @param params RPC 参数，需非空 `sessionId`。
   * @returns `{ sessionId, checkpoints }`。
   * @throws sessionId 缺失或为空时。
   */
  public async list(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('checkpoint.list 需要 sessionId');
    }
    const list = await this.manager().list(sessionId);
    return { sessionId, checkpoints: list };
  }

  /**
   * 为某会话创建检查点（对话索引 + 代码快照）。
   * @param params RPC 参数，需非空 `sessionId` 与非空 `label`。
   * @returns `{ ok: true, checkpoint }`。
   * @throws sessionId/label 缺失或为空时。
   */
  public async create(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId'];
    const label = params['label'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('checkpoint.create 需要 sessionId');
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error('checkpoint.create 需要 label');
    }
    const checkpoint = await this.manager().snapshot(sessionId, label);
    return { ok: true, checkpoint };
  }

  /**
   * 回滚到某会话的检查点（缺省回滚到最近一个）。
   * @param params RPC 参数，需非空 `sessionId`；可选 `label`。
   * @returns `{ ok: true, checkpoint }`。
   * @throws sessionId 缺失或为空时。
   */
  public async rollback(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('checkpoint.rollback 需要 sessionId');
    }
    const label = typeof params['label'] === 'string' ? params['label'] : undefined;
    const checkpoint = await this.manager().rollback(sessionId, label);
    return { ok: true, checkpoint };
  }

  /**
   * 惰性构造检查点管理器（复用会话 StoragePort + Git 文件快照适配器）。
   * @returns 新的 CheckpointManager 实例。
   */
  private manager(): CheckpointManager {
    return new CheckpointManager(this.options.storage, {
      snapshotter: new GitWorkspaceSnapshot(),
      workspaceRoot: this.options.workspaceRoot ?? process.cwd(),
    });
  }
}
