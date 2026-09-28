/**
 * `view_media` 全链路接线单测（**装配产物**级，不是类自身）。
 *
 * ## 为什么要单独钉这一条
 *
 * 本仓最高频的缺陷形态是「**声明未接线**」：工具类写在 `adapters/` 里、自身单测也绿，
 * 但组合根漏注册 ⇒ 模型在生产路径上根本看不到它；更隐蔽的一种是
 * 「新增**只读**工具忘了同步两处硬编码清单」——`planApproval` 的只读白名单与
 * `toolGate.sandboxActionOf` 的动作归类。漏前者 ⇒ plan 模式下 fail-closed 误拒（功能不可用）；
 * 漏后者 ⇒ 掉进 `command` 分支，在限制命令执行的沙箱下被误拒，且审批/沙箱展示的目标文案
 * 退化成「当命令看」。两处都不会被 TypeScript 发现，只能靠断言装配产物与裁决行为来钉。
 *
 * 故本文件断言三件事，且**全部走真实装配/真实裁决路径**（不复制被测逻辑）：
 * ① `ConfigFactory.build(...).tools.list()` 里真的有 `view_media`；
 * ② `PlanApproval.decide({toolName:'view_media'})` 放行；
 * ③ `ToolGate` 对 `view_media` 请求沙箱的动作为 `file_read`，目标取 `path` 参数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { PlanApproval } from '../../src/adapters/approval/planApproval.js';
import { ToolGate } from '../../src/core/toolGate.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import { RoutingFrameExtractor } from '../../src/adapters/media/routingFrameExtractor.js';
import { GifFrameExtractor } from '../../src/adapters/media/gifFrameExtractor.js';
import { FfmpegFrameExtractor } from '../../src/adapters/media/ffmpegFrameExtractor.js';
import { MediaStackAssembler } from '../../src/config/mediaStackAssembler.js';
import { FrameEncoder } from '../../src/media/frameEncoder.js';
import { PngEncoder } from '../../src/media/pngEncoder.js';
import { ViewMediaTool } from '../../src/adapters/tool/media/viewMediaTool.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.js';
import type {
  SandboxAction,
  SandboxDecision,
  SandboxPort,
} from '../../src/ports/runtime/sandbox.js';

/** 空转事件端口（本测试只关心装配与裁决，不关心事件流）。 */
class NullEventPort implements EventPort {
  /** 端口名。 */
  public readonly name = 'null';

  /**
   * 丢弃事件。
   * @param _event 运行时发出的事件（本测试不消费）。
   * @returns 无返回值。
   */
  public emit(_event: SessionEvent): void {
    /* 本测试不需要事件流 */
  }
}

/** 不回话的模型（装配期不会被调用）。 */
class SilentModel implements ModelPort {
  /** 端口名。 */
  public readonly name = 'silent';

  /**
   * 返回空文本。
   * @returns 空文本输出。
   */
  public async generate(): Promise<ModelOutput> {
    return { text: '' };
  }
}

/** 记录请求动作的沙箱（用来观测 `ToolGate` 到底按哪种动作去问沙箱）。 */
class RecordingSandbox implements SandboxPort {
  /** 端口名。 */
  public readonly name = 'recording';

  /** 收到的最后一个动作。 */
  public last: SandboxAction | undefined;

  /**
   * 记录并放行。
   * @param action 待裁决动作。
   * @returns 恒放行。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    this.last = action;
    return { allowed: true };
  }
}

/**
 * 构造最小可用配置基线。
 *
 * @returns 可直接喂给 `ConfigFactory.build` 的配置片段。
 */
const base = (): OmniHarnessConfig => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 2,
  model: new SilentModel(),
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new NullEventPort(),
});

test('装配产物：默认工具集含 view_media（库里有能力 ≠ 路径上生效）', () => {
  const names = ConfigFactory.build(base())
    .tools.list()
    .map((definition) => definition.name);
  assert.ok(
    names.includes(TOOL_NAMES.viewMedia),
    `装配产物缺 ${TOOL_NAMES.viewMedia}，实际：${names.join(',')}`,
  );
  assert.strictEqual(TOOL_NAMES.viewMedia, 'view_media', '对外契约名不得漂移');
});

test('plan 模式只读白名单：view_media 必须放行（漏登记即 fail-closed 误拒）', async () => {
  const plan = new PlanApproval();
  assert.strictEqual(
    await plan.decide({ sessionId: 's1', toolName: TOOL_NAMES.viewMedia, target: 'a.mp4' }),
    'allow',
    '抽帧读媒体不落盘任何产物（帧走内存附件），属只读工具',
  );
});

test('toolGate 动作归类：view_media 按 file_read 问沙箱，目标取 path 参数', async () => {
  const sandbox = new RecordingSandbox();
  const gate = new ToolGate(new AutoApproval(), sandbox);
  const denial = await gate.gate(
    { id: 'c1', name: TOOL_NAMES.viewMedia, arguments: { path: 'clip.mp4' } },
    's1',
  );
  assert.strictEqual(denial, undefined, '放行时不应返回拒绝结果');
  assert.strictEqual(
    sandbox.last?.kind,
    'file_read',
    '不得掉进 command 分支（会被限命令沙箱误拒）',
  );
  assert.strictEqual(sandbox.last?.target, 'clip.mp4', '目标应为媒体文件路径，而非工具名');
});

test('提取路由：按大类分发；静态图片与未知格式给出可行动提示', async () => {
  const stack = MediaStackAssembler.assemble(undefined);
  const router = stack.extractor;
  assert.strictEqual(router.supports('gif'), true, 'GIF 路径零外部依赖，任何机器可用');
  assert.strictEqual(router.supports('video'), true, '视频路径由 ffmpeg 提取器承接');
  assert.strictEqual(router.supports('unknown'), false, '未知大类无人支持 ⇒ 不值得尝试');

  const asked = await router.extract({
    absolutePath: 'x.png',
    probe: {
      kind: 'image',
      container: 'png',
      codec: undefined,
      width: 8,
      height: 8,
      durationMs: undefined,
      frameCount: undefined,
      frameRate: undefined,
      animated: false,
    },
    selection: {
      strategy: 'uniform',
      maxFrames: 4,
      startMs: 0,
      endMs: undefined,
      sceneThreshold: 0.3,
      maxDimension: 256,
      maxFrameBytes: 100_000,
      maxTotalBytes: 400_000,
    },
    timeoutMs: 1_000,
  });
  assert.deepStrictEqual(asked.frames, [], '静态图片不应产出帧');
  assert.ok(
    (asked.notes[0] ?? '').includes('view_image'),
    '必须把「改用 view_image」这句可行动提示带出来（文案单一来源）',
  );
  assert.ok(RoutingFrameExtractor.explain('unknown', 'weird').includes('mp4'));
  assert.deepStrictEqual(stack.options.maxFrames > 0, true, '默认选项必须已收敛为有效值');
});

test('提取器能力声明：GIF 提取器只认 gif、ffmpeg 提取器只认 video（互斥即路由正确性的前提）', () => {
  const encoder = new FrameEncoder(128, 100_000);
  const gif = new GifFrameExtractor(1024, encoder);
  assert.strictEqual(gif.name, 'gif-decoder');
  assert.strictEqual(gif.supports('gif'), true);
  assert.strictEqual(gif.supports('video'), false);
  assert.strictEqual(gif.supports('image'), false);
  assert.strictEqual(
    FfmpegFrameExtractor.prototype.supports.call({}, 'video'),
    true,
    '视频走 ffmpeg',
  );
});

test('失败文案：转介提示恰好出现一次（路由层已放进 notes，工具层不得再前置一遍）', async () => {
  const workspaceRoot = tempWorkspace();
  // 造一张**真实**的 PNG（而不是伪造文件头）：嗅探按魔数判为静态图片，才会走到转介分支。
  writeFileSync(
    path.join(workspaceRoot, 'still.png'),
    PngEncoder.encode({ rgba: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 }),
  );
  const stack = MediaStackAssembler.assemble(undefined);
  const tool = new ViewMediaTool({
    workspaceRoot,
    extractor: stack.extractor,
    options: stack.options,
  });
  const result = await tool.handle(
    { id: 'c-still', name: TOOL_NAMES.viewMedia, arguments: { path: 'still.png' } },
    { sessionId: 's-still', workspaceRoot },
  );
  assert.strictEqual(result.ok, false, '静态图片不得被当作动图抽出帧');
  const error = result.error ?? '';
  const occurrences = error.split('view_image').length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `转介提示应恰好出现一次（重复会让模型以为是两个不同问题），实际 ${String(occurrences)} 次：${error}`,
  );
});
