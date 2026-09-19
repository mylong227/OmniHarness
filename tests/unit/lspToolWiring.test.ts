/**
 * LSP 符号 / 代码操作工具的**装配级**回归（不是工具类自身的单测）。
 *
 * 为什么必须单独钉这一条：本仓最高频的缺陷形态是「**声明未接线**」——
 * 类写在 `adapters/` 里、自身单测全绿，但组合根漏注册 ⇒ 模型在生产路径上根本看不到它。
 * 故此处断言的是 `ConfigFactory.build(...).tools`（**装配产物**），并进一步**经装配产物真执行一次**，
 * 证明「注册了」不只是清单里有名字，而是处理器真的通到适配器。
 *
 * 另一半是**反向**断言：没配 `lspServer` 时这些工具必须**一个都不出现**——
 * 暴露一个注定失败的工具比不暴露更糟（模型会反复重试并浪费上下文）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.js';
import type { LspPort } from '../../src/ports/tool/lsp.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

const mockServer = resolve(process.cwd(), 'tests/fixtures/mockLspServer.mjs');

/** 空转事件端口。 */
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

/**
 * 构造最小可用配置基线。
 *
 * @param withLsp 是否注入 LSP 服务器配置。
 * @returns 可直接喂给 `ConfigFactory.build` 的配置片段。
 */
const base = (withLsp: boolean): OmniHarnessConfig => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 2,
  model: new SilentModel(),
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new NullEventPort(),
  ...(withLsp ? { lspServer: { serverCommand: process.execPath, serverArgs: [mockServer] } } : {}),
});

/** 名字取自三个注册点；只列本测试关心的 LSP 一族。 */
const LSP_TOOLS = [
  'lsp_go_to_definition',
  'lsp_find_references',
  'lsp_hover',
  'lsp_status',
  'lsp_diagnostics',
  'lsp_document_symbols',
  'lsp_code_action',
  'lsp_workspace_symbols',
] as const;

test('注入 lspServer 时，8 个 LSP 工具全部出现在装配产物里', () => {
  const names = ConfigFactory.build(base(true))
    .tools.list()
    .map((definition) => definition.name);
  for (const expected of LSP_TOOLS) {
    assert.ok(names.includes(expected), `装配产物缺 ${expected}，实际：${names.join(',')}`);
  }
});

test('未注入 lspServer 时，LSP 工具一个都不出现（不留死工具）', () => {
  const names = ConfigFactory.build(base(false))
    .tools.list()
    .map((definition) => definition.name);
  for (const unexpected of LSP_TOOLS) {
    assert.ok(!names.includes(unexpected), `未配置 LSP 却注册了 ${unexpected}`);
  }
});

test('经装配产物真执行 lsp_document_symbols：处理器确实通到适配器', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'omni-lsp-wiring-'));
  let lsp: LspPort | undefined;
  try {
    const file = join(workDir, 'demo.ts');
    writeFileSync(file, 'export const placeholder = 1;\n', 'utf8');
    const config = ConfigFactory.build({ ...base(true), workspaceRoot: workDir });
    lsp = config.lsp;

    const result = await config.tools.execute(
      { id: 'c1', name: 'lsp_document_symbols', arguments: { file } },
      { sessionId: 's1', workspaceRoot: workDir },
    );

    assert.strictEqual(result.ok, true, `装配产物执行失败：${result.error ?? ''}`);
    assert.match(result.output ?? '', /class DemoClass — /);
    // 渲染格式是 `<kind> <name> — file:line:col`，嵌套符号的 name 自带两空格缩进 ⇒
    // 行首是 kind 而不是缩进。这条断言同时钉住「层级没被压平丢掉」与「kind 已翻译成可读名」。
    assert.match(result.output ?? '', /^field\s+fieldOne — /m, '层级缩进要保留');
    assert.match(result.output ?? '', /function topLevelFn — /);
  } finally {
    // 必须关掉真 spawn 的语言服务器子进程，否则它会把 node 的事件循环钉住、测试文件永不退出。
    await lsp?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('能力门禁判据：只实现导航的端口在 symbols/codeActions 上必须是 undefined', () => {
  // 注册侧的门禁是 `lsp.symbols !== undefined`。这条断言钉住「该判据对不支持的适配器真的为假」——
  // 若哪天有人把这两个方法改成**必填**，门禁会恒为真，第三方「只会导航」的适配器就会拿到
  // 一个必然报错的死工具。这里在类型层与运行层同时钉住「可选」这一契约。
  const navOnly: LspPort = {
    name: 'nav-only',
    definition: async () => [],
    references: async () => [],
    hover: async () => undefined,
    shutdown: async () => undefined,
  };
  assert.strictEqual(navOnly.symbols === undefined, true);
  assert.strictEqual(navOnly.codeActions === undefined, true);
});
