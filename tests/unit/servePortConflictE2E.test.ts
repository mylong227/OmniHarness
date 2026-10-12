/**
 * `serve` 端口冲突的**端到端**判据（2026-10-11，真起进程）。
 *
 * 单元判据（`servePortConflict.test.ts`）证明分类逻辑与拒绝路径正确；这一条证明**接线之后**
 * 用户实际会遇到什么：
 *
 * | # | 场景 | 期望 |
 * | --- | --- | --- |
 * | ① | A 已在 8787（此处用临时端口）跑着，B 再起同一端口 | B 退出码非 0，stderr **点名端口、A 的 PID，并给三条出路**；A **仍活着**（默认绝不杀） |
 * | ② | C 用 `--take-port` 起同一端口 | C **绑定成功**（打印 UI 地址），A 已被终止 |
 * | ③ | 占用者**不是**本程序（占位的是普通 HTTP 服务） | 即使带 `--take-port` 也**拒绝接管**并如实报"非本程序的进程" |
 *
 * 判据用临时工作区（`--workspace <tmp>`）避免依赖本机固定项目配置，从而在 CI 上同样可跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 仓库根。 */
const REPO_ROOT = process.cwd();
/** CLI 入口。 */
const CLI = join(REPO_ROOT, 'dist/src/cli/exec.js');

/** 一起跑过的子进程（收尾统一清）。 */
const started: ChildProcess[] = [];

/**
 * 找一个空闲端口。
 * @returns 端口号
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * 起一个 serve 子进程。
 * @param args 子命令参数
 * @param workspace 临时工作区
 * @returns 子进程与输出累积器
 */
function startServe(
  args: readonly string[],
  workspace: string,
): { proc: ChildProcess; out: () => string } {
  const proc = spawn(process.execPath, [CLI, 'serve', '--workspace', workspace, ...args], {
    cwd: REPO_ROOT,
    // 与仓内其它 CLI 子进程同一取舍：本判据只关心端口绑定/接管，不需要检索与 repo-map
    // ⇒ 关掉它们，别给同跑的重文件（dshWorker / embeddingPreload / evolutionCommand）添负载。
    env: { ...process.env, OMNI_REPO_MAP: '0', OMNI_SEMANTIC_RECALL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(proc);
  let buffer = '';
  proc.stdout?.on('data', (d) => (buffer += String(d)));
  proc.stderr?.on('data', (d) => (buffer += String(d)));
  return { proc, out: () => buffer };
}

/**
 * 轮询某端口的 `/healthz`，直到拿到本程序健康体（或超时）。
 * @param port 端口
 * @param timeoutMs 超时
 * @returns 健康体或 null
 */
async function waitHealth(
  port: number,
  timeoutMs = 20_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
        signal: AbortSignal.timeout(1500),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (body['status'] === 'ok' && typeof body['pid'] === 'number') {
        return body;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * 等子进程退出，返回退出码与输出。
 * @param proc 子进程
 * @param timeoutMs 超时
 * @returns 退出码与输出
 */
function waitExit(
  proc: ChildProcess,
  timeoutMs = 30_000,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let buffer = '';
    proc.stdout?.on('data', (d) => (buffer += String(d)));
    proc.stderr?.on('data', (d) => (buffer += String(d)));
    const timer = setTimeout(() => resolve({ code: null, out: buffer }), timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: buffer });
    });
  });
}

/**
 * 轮询直到该端口的占用者**换成别的 PID**（接管场景用）。
 *
 * 为什么要它：接管是"先杀旧的、再绑新的"，中间有一段时间旧进程仍在应答
 * （首版直接 `waitHealth` ⇒ 立刻拿到旧 PID，判据抢跑假红）。
 * @param port 端口
 * @param previousPid 已知的旧 PID
 * @param timeoutMs 超时
 * @returns 新占用者的健康体或 null
 */
async function waitHealthChanged(
  port: number,
  previousPid: number,
  timeoutMs = 25_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await waitHealth(port, 1500);
    if (body !== null && body['pid'] !== previousPid) {
      return body;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * 进程是否还活着。
 * @param pid PID
 * @returns 活着为 true
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('端到端：默认只报可行动诊断（不杀），--take-port 才接管；非本程序占用则拒绝接管', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'omni-port-'));
  const port = await freePort();
  try {
    // ── ① A 起在目标端口 ──
    const a = startServe(['--port', String(port)], workspace);
    const health = await waitHealth(port);
    // **不 skip**：serve 起不来是**真问题**（本判据的前置条件没满足）⇒ 必须红并带上输出。
    // 静默跳过就是"看着绿"；skip 清点判据也会拒收没有开关的 skip（2026-10-11 实测被它抓到）。
    assert.ok(health !== null, `serve 未能在 20s 内就绪：\n${a.out().slice(-600)}`);
    const pidA = health['pid'] as number;
    assert.ok(alive(pidA), '占用者应存活');

    // ── ② 同端口再起一个（不带 --take-port）⇒ 必须失败且给出可行动信息，且**不杀** A ──
    const b = startServe(['--port', String(port)], workspace);
    const bExit = await waitExit(b.proc);
    assert.notStrictEqual(bExit.code, 0, `同端口启动应失败：\n${bExit.out}`);
    assert.match(bExit.out, /EADDRINUSE/u, '应保留原始错误码，便于检索');
    assert.match(bExit.out, new RegExp(String(port), 'u'), '提示必须点明端口');
    assert.match(bExit.out, new RegExp(String(pidA), 'u'), '提示必须点明占用者 PID');
    assert.match(bExit.out, /--port \d+/u, '必须给出"换端口"的具体命令');
    assert.match(bExit.out, /--take-port/u, '必须给出显式接管这条路');
    assert.ok(alive(pidA), '默认**绝不**杀占用者（A 必须还活着）');

    // ── ③ 带 --take-port ⇒ 接管成功，A 被终止 ──
    const c = startServe(['--port', String(port), '--take-port'], workspace);
    const cHealth = await waitHealthChanged(port, pidA);
    assert.ok(cHealth !== null, `--take-port 应接管成功：\n${c.out().slice(-600)}`);
    assert.notStrictEqual(
      cHealth?.['pid'],
      pidA,
      `接管后占用者应是新进程（C 的输出：\n${c.out().slice(-600)}）`,
    );
    for (let i = 0; i < 20 && alive(pidA); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(alive(pidA), false, '接管后旧占用者必须已退出');

    // ── ④ 占用者不是本程序 ⇒ 即便 --take-port 也拒绝接管 ──
    const foreignPort = await freePort();
    const foreign = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>not omniharness</html>');
    });
    await new Promise<void>((resolve) => foreign.listen(foreignPort, '127.0.0.1', resolve));
    try {
      const d = startServe(['--port', String(foreignPort), '--take-port'], workspace);
      const dExit = await waitExit(d.proc);
      assert.notStrictEqual(dExit.code, 0, '别人的进程占着 ⇒ 必须失败');
      assert.match(dExit.out, /非本程序的进程/u, '必须如实说明占用者不是自己人');
      assert.doesNotMatch(dExit.out, /正在终止占用者/u, '**不得**去终止非自己的进程');
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  } finally {
    for (const proc of started) {
      try {
        if (proc.pid !== undefined && alive(proc.pid)) {
          process.kill(proc.pid, 'SIGTERM');
        }
      } catch {
        /* 已退出 */
      }
    }
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
