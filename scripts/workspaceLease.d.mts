/** `scripts/workspaceLease.mjs` 的类型声明（供 TS 判据/设置脚本使用）。 */

export interface LeaseOwner {
  readonly token: number;
  readonly pid: number;
  readonly host: string;
  readonly at: number;
  readonly label: string;
}

export interface WorkspaceLeaseOptions {
  readonly name?: string;
  readonly ttlMs?: number;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
}

export interface AcquireOptions {
  readonly timeoutMs?: number;
  readonly label?: string;
}

export class WorkspaceLease {
  public constructor(root: string, options?: WorkspaceLeaseOptions);
  public readonly token: number;
  public acquire(options?: AcquireOptions): Promise<{ token: number; waitedMs: number }>;
  public tryAcquire(label?: string): boolean;
  public renew(): boolean;
  public release(): void;
  public holder(): LeaseOwner | undefined;
  public static readToken(file: string): number;
  public static readOwnerAt(dir: string): LeaseOwner | undefined;
}

export function withWorkspaceLease<T>(
  root: string,
  task: () => Promise<T>,
  options?: WorkspaceLeaseOptions & AcquireOptions,
): Promise<T>;
