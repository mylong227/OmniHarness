import type { PluginPermission } from '../../ports/plugin/pluginPermission.ts';
import { SafeFs } from '../../server/services/safeFs.ts';
import { PluginWorkerLimits } from './pluginWorkerLimits.ts';

/** 能力 broker 的调用请求。 */
export interface WorkerCapabilityCall {
  /** 能力名（如 `fs`）。 */
  readonly capability: string;
  /** 方法名（如 `read`）。 */
  readonly method: string;
  /** 参数（已由 Worker 序列化）。 */
  readonly params: unknown;
}

/**
 * 远程插件能力 broker（ADR-0012）。
 *
 * Worker 不能直接碰宿主对象；每次能力调用都到这里按插件**声明权限 + 工作区 scope**裁决。
 * 首版只开放 `fs.read`（只读、SafeFs 双重越界校验、1 MiB 上限）；其余一律
 * `UNAUTHORIZED_CAPABILITY`。写/网络/进程能力故意不开，避免把能力 broker 变成新的逃逸面。
 */
export class WorkerCapabilityBroker {
  /**
   * @param workspaceRoot 工作区根（fs.read 的唯一可读 scope）。
   * @param permissions 插件清单声明的权限（已由 PermissionGate 校验过白名单）。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly permissions: readonly PluginPermission[],
  ) {}

  /**
   * 执行一次能力调用。
   * @param call 能力/方法/参数。
   * @returns 能力结果（JSON 可序列化）。
   * @throws Error `UNAUTHORIZED_CAPABILITY` / `INVALID_FRAME`。
   */
  public async call(call: WorkerCapabilityCall): Promise<unknown> {
    if (call.capability !== 'fs' || call.method !== 'read') {
      throw new Error(`UNAUTHORIZED_CAPABILITY: ${call.capability}.${call.method}`);
    }
    if (!this.permissions.includes('fs.read')) {
      throw new Error('UNAUTHORIZED_CAPABILITY: 插件未声明 fs.read');
    }
    const path = (call.params as { path?: unknown } | undefined)?.path;
    if (typeof path !== 'string' || path === '') {
      throw new Error('INVALID_FRAME: fs.read 缺少 path');
    }
    const result = SafeFs.safeReadFile(
      this.workspaceRoot,
      path,
      PluginWorkerLimits.CAPABILITY_READ_MAX_BYTES,
    );
    if (!result.ok) {
      throw new Error(`UNAUTHORIZED_CAPABILITY: ${result.error}`);
    }
    return { path, text: result.buffer.toString('utf8') };
  }
}
