/**
 * E2：A2A 跨进程实测 + 真实子代理委托链路。
 *
 * 看板 E2 的可证伪验收是两例：
 *   ① **跨进程部署形态**：对端跑在**另一个操作系统进程**里，经真实 TCP（HTTP / WebSocket）通信；
 *   ② **真实子代理委托链路**：对端的任务处理器经 `SubagentRuntimeFactory` + 真实 `Agent` 执行委托。
 *
 * 覆盖：
 *   1. 跨进程 HTTP：父进程 A2aClient → 子进程 A2aServer → 子代理（真实 Agent），
 *      产出文本带**子进程 pid** → 证明「由另一个进程里的真实子代理完成」；
 *   2. 跨进程 WebSocket：同上，承载换成 RFC6455 长连接（`/a2a-ws`）；
 *   3. 跨进程 fail-closed：对端配真实 Ed25519 身份，未签名的委托必须被拒；
 *   4. 装配透传护栏 + `createRuntime` 真装配：显式 `a2a` 不再被 `ConfigFactory.build` 静默丢弃，
 *      且运行时装配出的 client/server 能在本进程内完成一次真实委托（修补前 `config.a2a` 恒 undefined
 *      → `runtime.a2a` 永远不装配，本用例必红）；
 *   5. 缺省关零破坏：不显式开启时 `a2a` 与 `runtime.a2a` 均为 undefined，且不监听任何端口。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { Readable } from 'node:stream';

import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/core/runtime.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import { A2aClient, HttpA2aTransport, WsA2aTransport } from '../../src/a2a/index.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';

/** 对端夹具脚本路径（dist/tests/fixtures/a2aPeerProcess.js）。 */
function fixturePath(): string {
  return fileURLToPath(new URL('../fixtures/a2aPeerProcess.js', import.meta.url));
}

/** 已拉起的对端进程。 */
interface Peer {
  /** 子进程句柄。 */
  readonly child: ChildProcess;
  /** 对端实际监听端口（`--port 0` 由系统分配）。 */
  readonly port: number;
  /** 终止对端并等待退出。 */
  stop(): Promise<void>;
}

/**
 * 等待就绪行 `A2A_READY <port>`。
 * @param stdout 对端进程 stdout。
 * @returns 实际监听端口。
 */
function waitForReady(stdout: Readable): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`对端进程启动超时（10s）；已收输出：${buffer}`));
    }, 10_000);
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const matched = /A2A_READY (\d+)/.exec(buffer);
      if (matched !== null) {
        clearTimeout(timer);
        resolve(Number(matched[1]));
      }
    });
  });
}

/**
 * 拉起一个独立的对端进程（真实 A2aServer + 真实子代理链路）。
 * @param transport 传输形态（http / ws）。
 * @param identityKey 可选：PKCS#8 base64 私钥；提供则对端启用 fail-closed 验签。
 * @returns 已就绪的对端句柄。
 */
async function startPeer(transport: 'http' | 'ws', identityKey?: string): Promise<Peer> {
  const args = [fixturePath(), '--port', '0', '--transport', transport];
  if (identityKey !== undefined) {
    args.push('--identity');
  }
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, A2A_PEER_IDENTITY_KEY: identityKey ?? '' },
  });
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error('无法读取对端进程 stdout');
  }
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    const port = await waitForReady(stdout);
    return {
      child,
      port,
      stop: async () => {
        child.kill();
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
      },
    };
  } catch (error) {
    child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}；stderr=${stderr}`);
  }
}

/** 抓一个空闲 TCP 端口（listen(0) 取实际端口后释放）。 */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 确定性桩模型：一步收敛，输出固定文本。 */
function fixedModel(text: string): ModelPort {
  return {
    name: 'a2a-wiring-stub',
    async generate(_request: ModelRequest): Promise<ModelOutput> {
      return { text };
    },
  };
}

/**
 * 构造最小可用的未解析运行配置（仅必需端口，其余走默认）。
 * @param workspaceRoot 工作区根。
 * @param extra 追加覆盖项。
 * @returns OmniHarnessConfig
 */
function basePartial(
  workspaceRoot: string,
  extra: Partial<OmniHarnessConfig> = {},
): OmniHarnessConfig {
  return {
    workspaceRoot,
    maxSteps: 4,
    model: fixedModel('in-process-final'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...extra,
  };
}

/** 新建临时工作区目录。 */
function workspace(tag: string): string {
  return mkdtempSync(join(tmpdir(), `omni-${tag}-`));
}

test('E2 跨进程 HTTP：父进程委托 → 子进程真实子代理执行（输出携带子进程 pid）', async () => {
  const peer = await startPeer('http');
  const client = new A2aClient(new HttpA2aTransport(`http://127.0.0.1:${peer.port}/a2a`));
  try {
    const result = await client.delegateTask({ taskId: 'xp-http-1', task: 'reverse a string' });
    assert.strictEqual(result.ok, true, `对端应成功执行委托：${result.error ?? ''}`);
    assert.match(
      result.output,
      new RegExp(`peer-pid:${peer.child.pid}`),
      '输出必须携带**对端进程**的 pid —— 证明子代理在另一个进程内执行（同进程实现无法伪造出该 pid）',
    );
    assert.match(result.output, /task:reverse a string/, '委托任务原文须被带到对端并回传');
    assert.ok(result.steps >= 1, '真实子代理至少执行 1 步');
  } finally {
    client.close();
    await peer.stop();
  }
});

test('E2 跨进程 WebSocket：同一协议经 RFC6455 长连接承载', async () => {
  const peer = await startPeer('ws');
  const client = new A2aClient(new WsA2aTransport(`ws://127.0.0.1:${peer.port}/a2a-ws`));
  try {
    const result = await client.delegateTask({ taskId: 'xp-ws-1', task: 'sum 1..100' });
    assert.strictEqual(result.ok, true, `对端应成功执行委托：${result.error ?? ''}`);
    assert.match(result.output, new RegExp(`peer-pid:${peer.child.pid}`));
    assert.match(result.output, /task:sum 1\.\.100/);
  } finally {
    client.close();
    await peer.stop();
  }
});

test('E2 跨进程 fail-closed：对端要求签名时，未签名的委托必须被拒', async () => {
  const keyMaterial = new Ed25519AgentIdentity();
  const key = keyMaterial.privateKeyPkcs8Base64();
  const peer = await startPeer('http', key);
  const unsigned = new A2aClient(new HttpA2aTransport(`http://127.0.0.1:${peer.port}/a2a`));
  const signed = new A2aClient(
    new HttpA2aTransport(`http://127.0.0.1:${peer.port}/a2a`),
    new Ed25519AgentIdentity({ privateKeyPkcs8Base64: key, agentRuntimeId: 'a2a-peer-client' }),
  );
  try {
    await assert.rejects(
      () => unsigned.delegateTask({ taskId: 'xp-auth-1', task: 'x' }),
      /UNAUTHORIZED/,
      '无签名请求必须被对端 fail-closed 拒绝',
    );
    const ok = await signed.delegateTask({ taskId: 'xp-auth-2', task: 'signed task' });
    assert.strictEqual(ok.ok, true, '同一密钥签名后应放行（真实验签，非桩）');
  } finally {
    unsigned.close();
    signed.close();
    await peer.stop();
  }
});

test('E2 装配透传 + 运行时真装配：显式 a2a 不再被静默丢弃，且可完成一次真实委托', async () => {
  const port = await freePort();
  const config = ConfigFactory.build(
    basePartial(workspace('a2a-wire'), {
      a2a: { enabled: true, port, peerEndpoint: `http://127.0.0.1:${port}/a2a` },
    }),
  );
  assert.ok(config.a2a !== undefined, 'a2a 必须活着穿到 ResolvedConfig（装配透传护栏）');
  assert.strictEqual(config.a2a.enabled, true);

  const runtime = createRuntime(config);
  try {
    assert.ok(runtime.a2a !== undefined, '显式开启 → 运行时必须装配 A2A server/client');
    const result = await runtime.a2a.client.delegateTask({ taskId: 'in-proc-1', task: 'ping' });
    assert.strictEqual(result.ok, true, `本进程内自环委托应成功：${result.error ?? ''}`);
    assert.match(result.output, /in-process-final/, 'server 侧处理器须跑真实子代理并回传其产出');
  } finally {
    runtime.a2a?.transport.close?.();
  }
});

test('E2 缺省关零破坏：未显式开启时 a2a 与 runtime.a2a 均不存在', () => {
  const config = ConfigFactory.build(basePartial(workspace('a2a-off')));
  assert.strictEqual(config.a2a, undefined, '缺省不得写入 a2a');
  const runtime = createRuntime(config);
  assert.strictEqual(runtime.a2a, undefined, '缺省不得装配 A2A（零监听、零行为变更）');
});
