/**
 * 测试夹具：A2A 对端进程（E2 跨进程实测）。
 *
 * 本夹具是**独立操作系统进程**内的一个完整 A2A 服务端：收到 `task.delegate` 后，
 * 经 `SubagentRuntimeFactory` 构造隔离子运行时、由真实 `Agent` 执行该委托（模型为确定性桩，
 * 无网络、无 LLM），再回传 `DelegateResult`。子代理产出文本携带 `peer-pid:<本进程 pid>`，
 * 供父进程测试断言「委托确实在**另一个进程**中由真实子代理完成」。
 *
 * 用法（由 `a2aCrossProcess.test.ts` 以子进程方式拉起）：
 *   node dist/tests/fixtures/a2aPeerProcess.js --port 0 --transport http|ws [--identity]
 * 环境变量 `A2A_PEER_IDENTITY_KEY`（PKCS#8 der base64）配合 `--identity` 启用 fail-closed 验签。
 * 就绪后向 stdout 打印一行 `A2A_READY <实际端口>`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.js';
import type { DelegateRequest, DelegateResult } from '../../src/a2a/index.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { Agent } from '../../src/core/agent.js';
import { SubagentRuntimeFactory } from '../../src/subagent/subagentRuntimeFactory.js';
import {
  A2aServer,
  HttpA2aServerTransport,
  WsA2aServerTransport,
  A2A_WS_PATH,
} from '../../src/a2a/index.js';

/** 确定性桩模型：不产出工具调用（子代理一步收敛），文本携带本进程 pid。 */
const stubModel: ModelPort = {
  name: 'a2a-peer-stub',
  async generate(_request: ModelRequest): Promise<ModelOutput> {
    return { text: `peer-pid:${process.pid}` };
  },
};

/** 内存版长期记忆桩（不落盘）。 */
const memoryStub: LongTermMemoryPort = {
  name: 'a2a-peer-memory-stub',
  remember: (fact: MemoryFact): void => void fact,
  recall: (): readonly MemoryFact[] => [],
  all: (): readonly MemoryFact[] => [],
  get: (): MemoryFact | undefined => undefined,
  update: (): boolean => false,
  delete: (): boolean => false,
  get count(): number {
    return 0;
  },
};

/** 构造子代理端口集（工具为空：桩模型不产出工具调用）。 */
function buildPorts(): SubagentPortsShape {
  const spill = new MemorySpill();
  return {
    model: stubModel,
    tools: new RegistryToolPort(),
    storage: new MemoryStorage(),
    events: new SilentEventPort(),
    sandbox: new PassthroughSandbox(),
    approvals: new AutoApproval(),
    escalation: new DenyEscalation(),
    elevatedSandbox: new PassthroughSandbox(),
    spill,
    spiller: new ToolResultSpiller(spill, { maxInlineBytes: 1024, previewBytes: 256 }),
    workspaceRoot: mkdtempSync(join(tmpdir(), 'omni-a2a-peer-')),
    maxSteps: 4,
    longTermMemory: memoryStub,
    goalMaxIterations: 4,
  };
}

/**
 * 取 `--flag value` 形式的参数值（裸开关返回空串，未出现返回 undefined）。
 * @param name 旗标名（含前导 `--`）。
 * @returns 旗标取值；未提供时为 undefined。
 */
function flagOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

const transport = flagOf('--transport') === 'ws' ? 'ws' : 'http';
const wantIdentity = flagOf('--identity') !== undefined;
const identityKey = process.env['A2A_PEER_IDENTITY_KEY'];
const identity = wantIdentity
  ? new Ed25519AgentIdentity({
      ...(identityKey !== undefined && identityKey.length > 0
        ? { privateKeyPkcs8Base64: identityKey }
        : {}),
      agentRuntimeId: 'a2a-peer-server',
    })
  : undefined;

const serverTransport =
  transport === 'ws' ? new WsA2aServerTransport() : new HttpA2aServerTransport();
const factory = new SubagentRuntimeFactory();
const server = new A2aServer(serverTransport, identity);
server.setTaskHandler({
  async handle(request: DelegateRequest): Promise<DelegateResult> {
    const start = Date.now();
    try {
      const ports = buildPorts();
      const sub = factory.build(ports, ports.tools, ports.events, ports.maxSteps);
      const result = await new Agent(sub).runTask(request.task);
      return {
        ok: true,
        output: `${result.finalText ?? ''}|task:${request.task}`,
        steps: result.steps,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: '', steps: 0, durationMs: Date.now() - start, error: message };
    }
  },
});

const actualPort = await serverTransport.listen(Number(flagOf('--port') ?? '0'));
process.stdout.write(`A2A_READY ${actualPort} path:${transport === 'ws' ? A2A_WS_PATH : '/a2a'}\n`);
