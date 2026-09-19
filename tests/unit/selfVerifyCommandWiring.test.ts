/**
 * 自验证「非 npm 仓库」接线的**端到端**验收（走生产装配路径）。
 *
 * 为什么必须走 `ConfigFactory.build` + 真实工具调用：本仓最高频的缺陷形态是
 * 「**声明未接线**」——策略类/装饰器单测全绿，但生产装配处漏传或闸门挡死，模型在真路径上
 * 永远看不到效果。原缺陷正是这种：`SelfVerifyPolicy.forWorkspace` 只认
 * `package.json#scripts.test`，**连显式 `selfVerify.command` 也一并被挡下**。
 *
 * 本测试用「一条必然失败、且带 marker 的测试命令」做信号：装饰器只在**失败**时回灌摘要
 * （通过时静默），于是「回灌里有没有 marker」就是「这条链到底通没通」的可证伪判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { SelfVerifyingToolPort } from '../../src/adapters/tool/verify/selfVerifyingToolPort.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/** 回灌信号（命令必然失败并打印它）。 */
const MARKER = 'SELFVERIFY_MARKER';

/** 空转事件端口（本测试不关心事件流）。 */
class NullEventPort implements EventPort {
  /** 端口名。 */
  public readonly name = 'null';

  /**
   * 丢弃事件。
   * @param _event 运行时发出的事件。
   * @returns 无返回值。
   */
  public emit(_event: SessionEvent): void {
    /* 不需要 */
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

/**
 * 造一个「必然失败的测试命令」临时仓库。
 *
 * @param extra 额外写入的文件（相对路径 → 内容），用于分别制造 npm / 非 npm 形态。
 * @returns 仓库根绝对路径。
 */
const makeRepo = (extra: Readonly<Record<string, string>> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), 'omni-svwire-'));
  writeFileSync(
    join(root, 'sv.mjs'),
    `console.error('${MARKER}');\nconsole.error('    at Object.<anonymous> (a.ts:1:1)');\nprocess.exit(1);\n`,
    'utf8',
  );
  for (const [rel, content] of Object.entries(extra)) {
    writeFileSync(join(root, rel), content, 'utf8');
  }
  return root;
};

/**
 * 构造最小可用配置基线。
 *
 * @param workspaceRoot 工作区根。
 * @param selfVerify 自验证配置片段（缺省不传 = 不启用）。
 * @returns 配置片段。
 */
const base = (
  workspaceRoot: string,
  selfVerify?: OmniHarnessConfig['selfVerify'],
): OmniHarnessConfig => ({
  workspaceRoot,
  maxSteps: 2,
  model: new SilentModel(),
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new NullEventPort(),
  ...(selfVerify !== undefined ? { selfVerify } : {}),
});

/**
 * 在工作区里写一个源码文件并返回工具结果文本。
 *
 * @param config 装配产物。
 * @param workspaceRoot 工作区根。
 * @returns 工具结果的 output 文本（无 output 时为空串）。
 */
const writeSource = async (
  config: ReturnType<typeof ConfigFactory.build>,
  workspaceRoot: string,
): Promise<string> => {
  const context: ToolContext = { sessionId: 's1', workspaceRoot };
  const result = await config.tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.ts', content: 'export const a = 1;\n' } },
    context,
  );
  return result.output ?? '';
};

test('装配：仓库无任何测试症状且未给命令 ⇒ 不包装自验证（fail-closed，零行为变更）', async () => {
  const root = makeRepo();
  try {
    const config = ConfigFactory.build(base(root, { enabled: true }));
    assert.ok(!(config.tools instanceof SelfVerifyingToolPort), '无测试证据时不应包装自验证装饰器');
    assert.ok(!(await writeSource(config, root)).includes(MARKER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('装配：显式 selfVerify.command 在非 npm 仓库上真的生效（原缺陷：被闸门挡死）', async () => {
  const root = makeRepo();
  try {
    const config = ConfigFactory.build(base(root, { enabled: true, command: 'node sv.mjs' }));
    assert.ok(config.tools instanceof SelfVerifyingToolPort, '显式命令应触发包装');

    const output = await writeSource(config, root);
    assert.ok(output.includes(MARKER), `回灌里应含测试失败输出，实际：${output}`);
    // 定位候选（堆栈帧 → 文件:行）也应一并回灌
    assert.ok(output.includes('a.ts:1'), `回灌应含位置候选，实际：${output}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('装配：探测出的命令（npm 形态）同样端到端生效', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node sv.mjs' } }),
  });
  try {
    const config = ConfigFactory.build(base(root, { enabled: true }));
    assert.ok(config.tools instanceof SelfVerifyingToolPort, 'npm 测试脚本应触发包装');
    assert.ok((await writeSource(config, root)).includes(MARKER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('装配：selfVerify.enabled=false 时即使有显式命令也不包装（可关是硬语义）', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node sv.mjs' } }),
  });
  try {
    const config = ConfigFactory.build(base(root, { enabled: false, command: 'node sv.mjs' }));
    assert.ok(!(config.tools instanceof SelfVerifyingToolPort));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
