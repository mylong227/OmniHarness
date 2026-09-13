import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/jsonRpc.js';
import type { A2aTransport } from '../../src/a2a/a2aProtocol.js';
import { A2aClient } from '../../src/a2a/a2aClient.js';
import { A2aServer, type TaskHandler } from '../../src/a2a/a2aServer.js';
import type {
  AgentIdentityPort,
  AgentIdentityClaims,
} from '../../src/ports/runtime/agentIdentity.js';
import type { DelegateRequest, DelegateResult } from '../../src/a2a/a2aProtocol.js';

/** 双端内存传输（服务端与客户端互联）。 */
class PairTransport implements A2aTransport {
  public readonly sent: RpcMessage[] = [];
  public peer: PairTransport | undefined;
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.sent.push(message);
    this.peer?.deliver(message);
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }
}

function pair(): { clientSide: PairTransport; serverSide: PairTransport } {
  const clientSide = new PairTransport();
  const serverSide = new PairTransport();
  clientSide.peer = serverSide;
  serverSide.peer = clientSide;
  return { clientSide, serverSide };
}

/** 自验签的桩身份（仅测 A2A 验签接线，非真实密码学身份）。 */
class StubIdentity implements AgentIdentityPort {
  public runtimeId(): string {
    return 'r1';
  }
  public publicKeySsh(): string {
    return 'ssh-ed25519 stub';
  }
  public privateKeyPkcs8Base64(): string {
    return 'stub';
  }
  public sign(p: string): string {
    return 'sig:' + p;
  }
  public verify(p: string, s: string): boolean {
    return s === 'sig:' + p;
  }
  public signAssertion(t: string): string {
    return 'env:' + t;
  }
  public verifyAssertion(e: string): AgentIdentityClaims | null {
    const payload = e.startsWith('AgentAssertion ') ? e.slice('AgentAssertion '.length) : e;
    if (!payload.startsWith('env:')) return null;
    return { agentRuntimeId: 'r1', taskId: payload.slice(4), timestamp: new Date().toISOString() };
  }
  public authorizationHeader(t: string): string {
    return 'AgentAssertion ' + this.signAssertion(t);
  }
}

/** 回显式任务处理器。 */
const echoHandler: TaskHandler = {
  async handle(req: DelegateRequest): Promise<DelegateResult> {
    return { ok: true, output: `ran:${req.task}`, steps: 1, durationMs: 1 };
  },
};

test('① 能力声明：客户端声明后服务端可查到', async () => {
  const { clientSide, serverSide } = pair();
  const server = new A2aServer(serverSide);
  const client = new A2aClient(clientSide);
  await client.declareCapabilities('agentA', [{ name: 'code-review' }]);
  const decl = server.getDeclaration('agentA');
  assert.ok(decl !== undefined);
  assert.strictEqual(decl.agentId, 'agentA');
  assert.strictEqual(decl.capabilities[0]?.name, 'code-review');
  client.close();
});

test('② 任务委托：handler 执行并返回结果', async () => {
  const { clientSide, serverSide } = pair();
  const server = new A2aServer(serverSide);
  server.setTaskHandler(echoHandler);
  const client = new A2aClient(clientSide);
  const res = await client.delegateTask({ taskId: 't1', task: 'reverse a string' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.output, 'ran:reverse a string');
  client.close();
});

test('③ fail-closed：无 handler 时委托被拒', async () => {
  const { clientSide, serverSide } = pair();
  const server = new A2aServer(serverSide); // 不配 handler
  const client = new A2aClient(clientSide);
  await assert.rejects(() => client.delegateTask({ taskId: 't2', task: 'x' }));
  client.close();
});

test('④ 验签：服务端配身份，无签名请求被拒（UNAUTHORIZED）', async () => {
  const { clientSide, serverSide } = pair();
  const server = new A2aServer(serverSide, new StubIdentity());
  server.setTaskHandler(echoHandler);
  // 客户端不带身份 → 不发 assertion → 服务端验签失败。
  const client = new A2aClient(clientSide);
  await assert.rejects(() => client.delegateTask({ taskId: 't3', task: 'x' }));
  client.close();
});

test('⑤ 验签通过：客户端带身份签名，委托成功', async () => {
  const { clientSide, serverSide } = pair();
  const server = new A2aServer(serverSide, new StubIdentity());
  server.setTaskHandler(echoHandler);
  const client = new A2aClient(clientSide, new StubIdentity());
  const res = await client.delegateTask({ taskId: 't4', task: 'do thing' });
  assert.strictEqual(res.ok, true);
  client.close();
});
