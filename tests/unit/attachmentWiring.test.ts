/**
 * 文件附件「声明未接线」回归测试（第十一处）。
 *
 * 缺陷形态：`FileAttachment` 能力在**三层都已就位**——
 *   ① `Agent.runTask/resume/fork` 公开 API 收 `files` 形参；
 *   ② `SessionRecorder.user(content, images, files)` 与 `eventFactory.user` 会把它写进
 *      `user` 事件 payload（审计真值）；
 *   ③ `ContextAssembler` 投影时 `filesOf(event)` 会把它挂到模型 user 消息上。
 * 但 **`Agent.continueSession` 调 `recorder.user(effectivePrompt, images)` 时漏传 `files`**
 * ⇒ 附件在**记录层**即被丢弃，下游两层的读路径永远拿到 `undefined`：
 * 「文件附件随用户消息送入模型」在生产路径上**不可达**。
 *
 * 该断链由 ESLint `@typescript-eslint/no-unused-vars`（形参 `files` 从未使用）暴露——
 * 即静态告警确实编码了真实死接线，而非纯风格噪声。
 *
 * 本测试锁死全链路（缺任一段即红）：
 *   ① 生产装配（`ConfigFactory.build` → `createRuntime`）
 *   ② 真跑 Agent（`runTask` / `resume`）后，**模型真收到的 user 消息**带 `files`
 *   ③ 缺省不传附件时，消息上**不得出现** `files` 键（零行为变更）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type {
  FileAttachment,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
} from '../../src/ports/model/model.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 测试用附件（一份「非图片」通用文件）。 */
const ATTACHMENTS: readonly FileAttachment[] = [
  { name: 'notes.md', mediaType: 'text/markdown', data: 'aGVsbG8=' },
  { name: 'trace.log', mediaType: 'text/plain', url: 'file:///tmp/trace.log' },
];

/** 录制型模型端口：保留每次真收到的请求，立即以文本收尾（不联网、不调工具）。 */
class RecordingTextModel implements ModelPort {
  /** 端口名。 */
  public readonly name = 'recording-text';
  /** 收到的全部请求（按发出顺序）。 */
  public readonly requests: ModelRequest[] = [];

  /**
   * 录制并回复固定文本。
   * @param request 模型请求。
   * @returns 纯文本输出（使回合一步收尾）。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.requests.push(request);
    return { text: '完成' };
  }
}

/**
 * 构造最小可用配置（走生产装配路径；workspaceRoot 指向临时工作区）。
 * @param model 录制型模型端口。
 * @returns 可交给 ConfigFactory.build 的输入。
 */
const base = (model: RecordingTextModel) => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 3,
  model,
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new SilentEventPort(),
  // 隔离变量：本测试只验证附件接线，关掉回合末蒸馏，避免额外旁路模型调用。
  memoryConsolidate: false,
});

/**
 * 取某次请求里第一条 user 消息。
 * @param request 模型请求。
 * @returns 该请求的 user 消息（不存在时为 undefined）。
 */
const userMessage = (request: ModelRequest): ModelMessage | undefined =>
  request.messages.find((m) => m.role === 'user');

/**
 * 取某次请求里全部 user 消息（resume 场景下首条是本轮新增、其余来自历史重放）。
 * @param request 模型请求。
 * @returns 该请求的全部 user 消息。
 */
const userMessages = (request: ModelRequest): readonly ModelMessage[] =>
  request.messages.filter((m) => m.role === 'user');

test('附件接线：runTask 传入的 files 必须真抵达模型 user 消息', async () => {
  const model = new RecordingTextModel();
  const agent = new Agent(Runtime.createRuntime(ConfigFactory.build(base(model))));
  await agent.runTask('看看这两个附件', undefined, ATTACHMENTS);

  assert.strictEqual(model.requests.length, 1, '本用例应只产生一次模型请求');
  const message = userMessage(model.requests[0]!);
  assert.ok(message !== undefined, '请求里应含 user 消息');
  assert.deepStrictEqual(
    message?.files,
    ATTACHMENTS,
    'files 必须逐字段抵达模型（修复前此处恒为 undefined）',
  );
});

test('附件接线：resume 路径同样把 files 透传到模型', async () => {
  const model = new RecordingTextModel();
  const agent = new Agent(Runtime.createRuntime(ConfigFactory.build(base(model))));
  const first = await agent.runTask('第一轮');
  const second = await agent.resume(first.sessionId, '第二轮带附件', undefined, ATTACHMENTS);

  assert.ok(second.sessionId.length > 0);
  const withFiles = model.requests
    .flatMap((r) => userMessages(r))
    .filter((m) => m.files !== undefined);
  assert.strictEqual(withFiles.length, 1, '恰好一条 user 消息带附件（resume 新增的那条）');
  assert.deepStrictEqual(withFiles[0]?.files, ATTACHMENTS);
});

test('附件接线：缺省不传附件时不得出现 files 键（零行为变更）', async () => {
  const model = new RecordingTextModel();
  const agent = new Agent(Runtime.createRuntime(ConfigFactory.build(base(model))));
  await agent.runTask('没有附件');

  const message = userMessage(model.requests[0]!);
  assert.ok(message !== undefined);
  assert.strictEqual('files' in message, false, '缺省路径不得凭空多出 files 字段');
  assert.strictEqual('images' in message, false, '缺省路径不得凭空多出 images 字段');
});
