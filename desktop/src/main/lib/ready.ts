/**
 * 等待 Harness 就绪并验证 /readyz 的纯逻辑（不依赖 Electron，便于单测）。
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** 与 src/cli/serveReadyFile.ts 的 ServeReadyInfo 对齐。 */
export interface ReadyInfo {
  readonly protocol: 1;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly workspace: string;
  readonly apiVersion: string;
  readonly harnessVersion: string;
  readonly startedAt: string;
}

/**
 * 校验就绪文件 JSON（结构不合法即当“还没就绪”）。
 * @param value 解析后的 JSON。
 * @returns 合法时为 ReadyInfo。
 */
export function parseReadyInfo(value: unknown): ReadyInfo | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const protocol = raw['protocol'];
  const pid = raw['pid'];
  const host = raw['host'];
  const port = raw['port'];
  const workspace = raw['workspace'];
  const apiVersion = raw['apiVersion'];
  const harnessVersion = raw['harnessVersion'];
  const startedAt = raw['startedAt'];
  if (protocol !== 1) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host === '') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof workspace !== 'string' || workspace === '') return null;
  if (typeof apiVersion !== 'string' || typeof harnessVersion !== 'string') return null;
  if (typeof startedAt !== 'string' || startedAt === '') return null;
  return { protocol, pid, host, port, workspace, apiVersion, harnessVersion, startedAt };
}

/**
 * 轮询就绪文件，直到出现合法内容、子进程退出或超时。
 * @param path 就绪文件路径。
 * @param child 侧车进程（用于提前判死）。
 * @param timeoutMs 总超时。
 * @returns 就绪信息。
 */
export async function waitForReadyFile(
  path: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<ReadyInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Harness 在就绪前退出（exitCode=${String(child.exitCode)}）`);
    }
    if (existsSync(path)) {
      try {
        const parsed = parseReadyInfo(JSON.parse(readFileSync(path, 'utf8')) as unknown);
        if (parsed !== null && parsed.pid === child.pid) return parsed;
      } catch {
        // 文件可能正在 rename 的瞬间：下一轮再读。
      }
    }
    await delay(50);
  }
  throw new Error(`等待 Harness 就绪超时（${String(timeoutMs)}ms）`);
}

/**
 * 带 Bearer 调 /readyz；启动瞬间可能还没 ready，故短重试。
 * @param port 实际端口。
 * @param token 本次启动 Token。
 * @param timeoutMs 总超时。
 * @returns 无返回值；失败抛错。
 */
export async function assertReadyz(port: number, token: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`/readyz 未就绪：${last}`);
}

/**
 * 等待子进程退出。
 * @param child 子进程。
 * @param timeoutMs 超时。
 * @returns 在超时前退出返回 true。
 */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 延时。
 * @param ms 毫秒。
 * @returns Promise。
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
