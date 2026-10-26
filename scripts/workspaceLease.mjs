#!/usr/bin/env node
/**
 * 工作区**共享文件系统租约**（构建 / 测试 / 未来跨机写入的互斥点）。
 *
 * ## 为什么需要它
 *
 * 两个会话同时 `npm run build` 会争用 `dist`：一次构件的 `rename` 窗口里，另一个进程
 * spawn `dist/src/...` 会看到 `ERR_MODULE_NOT_FOUND`；vitest 与 build 并发时同理。
 * 这不是代码缺陷，而是**共享工作区缺少租约**。
 *
 * ## 协议（共享文件系统上的分布式租约）
 *
 * - 目录：`<root>/.omniharness/leases/<name>/`，`mkdir` 原子创建 = 抢锁；
 * - `owner.json`：`{token, pid, host, at, label}`；`token` 由同目录外的水位文件单调递增
 *   （fencing：释放后重新获取的 token 一定更大，旧持有者不能误删新锁）；
 * - 租约 `ttlMs` 内没有心跳 ⇒ 视为持有者崩溃，可 `rename` 到 `.stale.*` 后接管
 *   （rename 原子，保证只有一个接管者成功）；
 * - 持锁期间每 `heartbeatMs` 刷新 `at`；释放只删 token 匹配的锁目录。
 *
 * ## 诚实边界
 *
 * 这依赖**共享文件系统**（本机多进程 / 共享盘多机），不提供网络分区下的 quorum 安全；
 * 真正跨机强一致需要 etcd/Raft 一类外部协调者。TTL 内的时钟偏差由 fencing token 兜底。
 *
 * 用法：
 * ```bash
 * node scripts/workspaceLease.mjs --name=workspace --ttl=120000 -- <command...>
 * ```
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 默认租约 TTL（毫秒）。 */
export const DEFAULT_TTL_MS = 120_000;
/** 默认最长等待（毫秒）。 */
export const DEFAULT_WAIT_MS = 30 * 60_000;
/** 默认轮询（毫秒）。 */
export const DEFAULT_POLL_MS = 50;
/** 默认心跳（毫秒）。 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * 持锁者信息。
 * @typedef {object} LeaseOwner
 * @property {number} token fencing token
 * @property {number} pid 持有者 pid
 * @property {string} host 持有者主机名
 * @property {number} at 最近心跳时刻（毫秒）
 * @property {string} label 人类可读标签
 */

/** 共享文件系统租约。 */
export class WorkspaceLease {
  /**
   * @param {string} root 工作区根
   * @param {{name?: string, ttlMs?: number, pollMs?: number, heartbeatMs?: number}} [options]
   */
  constructor(root, options = {}) {
    this.root = root;
    this.name = options.name ?? 'workspace';
    this.lockDir = join(root, '.omniharness', 'leases', this.name);
    this.watermark = `${this.lockDir}.token`;
    this.ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.pollMs = Math.max(5, options.pollMs ?? DEFAULT_POLL_MS);
    this.heartbeatMs = Math.max(50, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    /** @type {number} */
    this.token = 0;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.heartbeat = undefined;
  }

  /**
   * 有界等待获取租约。
   * @param {{timeoutMs?: number, label?: string}} [options]
   * @returns {Promise<{token: number, waitedMs: number}>}
   */
  async acquire(options = {}) {
    const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_WAIT_MS);
    const label = options.label ?? '';
    const started = Date.now();
    for (;;) {
      if (this.tryAcquire(label)) {
        return { token: this.token, waitedMs: Date.now() - started };
      }
      if (Date.now() - started >= timeoutMs) {
        const holder = this.holder();
        const who =
          holder === undefined
            ? '持有者信息不可读'
            : `pid=${String(holder.pid)} host=${holder.host} token=${String(holder.token)}`;
        throw new Error(
          `获取工作区租约超时（${String(timeoutMs)}ms，name=${this.name}；${who}）；` +
            '若确认旧持有者已崩溃，可删除 .omniharness/leases 下的陈旧锁目录。',
        );
      }
      await WorkspaceLease.sleep(this.pollMs * (0.5 + Math.random()));
    }
  }

  /**
   * 尝试获取一次（不等待）。
   * @param {string} [label]
   * @returns {boolean}
   */
  tryAcquire(label = '') {
    mkdirSync(dirname(this.lockDir), { recursive: true });
    let created = false;
    try {
      mkdirSync(this.lockDir);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!created) {
      if (!this.isExpired()) return false;
      if (!this.takeOver()) return false;
    }
    const previous = WorkspaceLease.readToken(this.watermark);
    this.token = previous + 1;
    WorkspaceLease.writeText(this.watermark, String(this.token));
    this.writeOwner(label);
    this.startHeartbeat();
    return true;
  }

  /**
   * 续租（心跳）。
   * @returns {boolean}
   */
  renew() {
    if (this.token === 0) return false;
    const owner = this.holder();
    if (owner === undefined || owner.token !== this.token) {
      this.token = 0;
      this.stopHeartbeat();
      return false;
    }
    this.writeOwner(owner.label);
    return true;
  }

  /**
   * 释放（只删 token 匹配的锁；幂等）。
   * @returns {void}
   */
  release() {
    this.stopHeartbeat();
    if (this.token === 0) return;
    const owner = this.holder();
    if (owner !== undefined && owner.token === this.token) {
      rmSync(this.lockDir, { recursive: true, force: true });
    }
    this.token = 0;
  }

  /**
   * 当前持有者。
   * @returns {LeaseOwner | undefined}
   */
  holder() {
    return WorkspaceLease.readOwnerAt(this.lockDir);
  }

  /**
   * 启动心跳。
   * @returns {void}
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.renew(), this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /**
   * 停止心跳。
   * @returns {void}
   */
  stopHeartbeat() {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /**
   * 租约是否过期（读不到 owner 时按目录 mtime 兜底）。
   * @returns {boolean}
   */
  isExpired() {
    const owner = this.holder();
    const at =
      owner?.at ??
      (() => {
        try {
          return statSync(this.lockDir).mtimeMs;
        } catch {
          return Date.now();
        }
      })();
    return Date.now() - at > this.ttlMs;
  }

  /**
   * 接管过期锁：rename 到 graveyard（原子，唯一赢家）后重建。
   * @returns {boolean}
   */
  takeOver() {
    const graveyard = `${this.lockDir}.stale.${String(process.pid)}.${String(Date.now())}`;
    try {
      renameSync(this.lockDir, graveyard);
    } catch {
      return false;
    }
    const token = Math.max(
      WorkspaceLease.readToken(graveyard),
      WorkspaceLease.readOwnerAt(graveyard)?.token ?? 0,
      WorkspaceLease.readToken(this.watermark),
    );
    rmSync(graveyard, { recursive: true, force: true });
    try {
      mkdirSync(this.lockDir);
    } catch {
      return false;
    }
    // 先把 token 写进去；真正的 owner 在 tryAcquire 里写。
    WorkspaceLease.writeText(this.watermark, String(token + 1));
    this.token = token + 1;
    return true;
  }

  /**
   * 写 owner.json。
   * @param {string} label
   * @returns {void}
   */
  writeOwner(label) {
    const owner = {
      token: this.token,
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
      label,
    };
    WorkspaceLease.writeText(join(this.lockDir, 'owner.json'), `${JSON.stringify(owner)}\n`);
  }

  /**
   * 读 token 水位。
   * @param {string} file
   * @returns {number}
   */
  static readToken(file) {
    try {
      const value = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 读某锁目录的 owner。
   * @param {string} dir
   * @returns {LeaseOwner | undefined}
   */
  static readOwnerAt(dir) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'));
      if (typeof parsed?.token !== 'number' || typeof parsed?.at !== 'number') return undefined;
      return {
        token: parsed.token,
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        host: typeof parsed.host === 'string' ? parsed.host : '',
        at: parsed.at,
        label: typeof parsed.label === 'string' ? parsed.label : '',
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 尽力写文本。
   * @param {string} file
   * @param {string} text
   * @returns {void}
   */
  static writeText(file, text) {
    try {
      writeFileSync(file, text, 'utf8');
    } catch {
      /* 锁信息写不进去不影响 mkdir 互斥；owner 缺失时 isExpired 用 mtime 兜底 */
    }
  }

  /**
   * 异步 sleep。
   * @param {number} ms
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}

/**
 * 在租约内跑一个异步任务。
 * @template T
 * @param {string} root
 * @param {() => Promise<T>} task
 * @param {{name?: string, timeoutMs?: number, label?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withWorkspaceLease(root, task, options = {}) {
  const lease = new WorkspaceLease(root, {
    ...(options.name !== undefined ? { name: options.name } : {}),
  });
  await lease.acquire({
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  });
  try {
    return await task();
  } finally {
    lease.release();
  }
}

// CLI：`node scripts/workspaceLease.mjs --name=workspace -- <command...>`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const nameArg = args.find((arg) => arg.startsWith('--name='));
  const separator = args.indexOf('--');
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  const root = process.cwd();
  const lease = new WorkspaceLease(root, {
    ...(nameArg !== undefined ? { name: nameArg.slice('--name='.length) } : {}),
  });
  await lease.acquire({ label: command.join(' ') });
  process.on('exit', () => lease.release());
  if (command.length === 0) {
    console.log(`[lease] 已获取 ${lease.lockDir}（token=${String(lease.token)}）；按 Ctrl-C 释放`);
  } else {
    const { spawn } = await import('node:child_process');
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      cwd: root,
      shell: process.platform === 'win32',
    });
    child.on('exit', (code, signal) => {
      lease.release();
      process.exit(signal === null ? (code ?? 1) : 1);
    });
  }
}
