/**
 * A2A 委托工具端到端判据（真实传输链路）。
 *
 * 与 {@link a2aDelegateTool.test.ts}（假传输，判工具语义）互补，本文件补**真链路**一段：
 * `a2a_delegate 工具 → A2aClient → 真实 HTTP POST /a2a → 对端 A2aServer → A2aTaskExecutor
 * → 真实子代理（MockModel）→ 结果原路返回`。此前工具判据只有假传输，真传输只有
 * a2aCrossProcess 的 client 直调——工具面这一跳从未被真链路覆盖。
 *
 * 判据：
 * ① 真实对端（独立 runtime、独立端口）上，工具调用返回子代理产出；
 * ② 输出可区分（对端固定文本经 MockModel 脚本产出，非本地回声）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

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

/** 起一个开启 A2A 的完整运行时（对端/父端同款装配）。 */
function runtimeWithA2a(
  port: number,
  peerEndpoint?: string,
): { config: OmniHarnessConfig; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-a2a-e2e-'));
  const config = ConfigFactory.build({
    workspaceRoot: dir,
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    a2a: {
      enabled: true,
      port,
      ...(peerEndpoint !== undefined ? { peerEndpoint } : {}),
    },
  });
  const runtime = Runtime.createRuntime(config);
  return {
    config,
    close: () => {
      runtime.a2a?.transport.close?.();
    },
  };
}

test('e2e：a2a_delegate 经真实 HTTP 链路委托给独立 runtime 的子代理并回收结果', async () => {
  // 对端：A2A 服务端 + A2aTaskExecutor（委托任务跑在**它自己**的受限子代理里）。
  const peerPort = await freePort();
  const peer = runtimeWithA2a(peerPort);
  try {
    // 父端：client 指向对端（peerEndpoint 显式覆盖默认回环推导）。
    const parentPort = await freePort();
    const parent = runtimeWithA2a(parentPort, `http://127.0.0.1:${String(peerPort)}/a2a`);
    try {
      const tools = parent.config.tools;
      assert.ok(tools !== undefined, 'config.tools 应已装配');
      const definition = tools.list().find((t) => t.name === 'a2a_delegate');
      assert.ok(definition !== undefined, '父端工具表应已注册 a2a_delegate');

      const call: ToolCall = {
        id: 'e2e-call-1',
        name: 'a2a_delegate',
        arguments: { task: '回一句证明你在另一个进程里跑着' },
      } as ToolCall;
      const context: ToolContext = {
        sessionId: 'sess-e2e',
        workspaceRoot: parent.config.workspaceRoot,
      };
      const result = await tools.execute(call, context);

      assert.strictEqual(result.ok, true, `工具应成功：${result.error ?? ''}`);
      assert.match(
        result.output ?? '',
        /任务完成（模拟模型适配器输出）/,
        '应含对端子代理的 MockModel 脚本产出',
      );
      assert.match(result.output ?? '', /\[a2a 对端\]/, '应带工具的转述前缀');
    } finally {
      parent.close();
    }
  } finally {
    peer.close();
  }
});
