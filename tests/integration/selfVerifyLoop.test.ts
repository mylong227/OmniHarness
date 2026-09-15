/**
 * P3 自验证回环端到端（集成）：**改坏代码 → 回环捕获 → 修好 → 通过**。
 *
 * 走生产装配的那一段代码（`ConfigToolRegistry.withSelfVerify`，即 `defaultTools` 内部
 * 装配装饰器所用的同一入口），配真实 `ShellTestCommandRunner`（真跑测试命令）与真实
 * `WriteFileTool`（真写盘）——不使用任何桩，以证明「写源码 → 自动跑受限测试 → 失败摘要回灌」
 * 在真实进程与真实文件系统上成立。
 *
 * 仓库夹具：临时目录内 `package.json`（`scripts.test = node check.mjs`）+ `check.mjs`
 * （校验 `src.js` 不含 `BROKEN`）。因此本测试同时验证了确定性触发器「仓库有测试症状」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigToolRegistry } from '../../src/config/configToolRegistry.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { WriteFileTool } from '../../src/adapters/tool/fs/writeFileTool.js';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';
import type { ToolCall, ToolContext, ToolPort } from '../../src/ports/tool/tool.js';

/** 失败夹具的测试脚本：`src.js` 含 BROKEN 即非零退出并打印 node --test 风格的失败行。 */
const CHECK_SCRIPT = [
  "import { readFileSync } from 'node:fs';",
  "const src = readFileSync(new URL('./src.js', import.meta.url), 'utf8');",
  "if (src.includes('BROKEN')) {",
  "  console.error('not ok 1 - src.js 含 BROKEN 标记');",
  '  process.exit(1);',
  '}',
  "console.log('ok 1 - src.js clean');",
].join('\n');

/** 造临时仓库（含测试症状）。 */
const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-selfverify-e2e-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'e2e-fixture', scripts: { test: 'node check.mjs' } }),
    'utf8',
  );
  writeFileSync(join(dir, 'check.mjs'), CHECK_SCRIPT, 'utf8');
  writeFileSync(join(dir, 'src.js'), 'export const a = 1;\n', 'utf8');
  return dir;
};

/** 构造「真实 registry + 写文件工具 + 自验证装饰器」的端口（等价于生产 defaultTools 的装配段）。 */
const buildPort = (dir: string, policy: SelfVerifyPolicy): ToolPort => {
  const registry = new RegistryToolPort();
  const writer = new WriteFileTool(dir);
  registry.register(writer.definition, (call, ctx) => writer.handle(call, ctx));
  return ConfigToolRegistry.withSelfVerify(registry, policy, dir);
};

/** 构造一次 write_file 调用。 */
const writeCall = (id: string, content: string): ToolCall => ({
  id,
  name: 'write_file',
  arguments: { path: 'src.js', content },
});

test('P3 端到端：改坏源码 → 回环捕获失败摘要 → 修好 → 静默通过', async () => {
  const dir = makeRepo();
  try {
    const policy = SelfVerifyPolicy.forWorkspace(dir, { cooldownMs: 0 });
    assert.ok(policy !== undefined, '含 scripts.test 的仓库应启用自验证');
    assert.strictEqual(policy.command, SelfVerifyPolicy.DEFAULT_COMMAND);

    const port = buildPort(dir, policy);
    const ctx: ToolContext = { sessionId: 's-e2e', workspaceRoot: dir };

    // ① 改坏代码：写含 BROKEN 的源码 → 回环应捕获并回灌失败摘要。
    const bad = await port.execute(writeCall('c1', "export const a = 'BROKEN';\n"), ctx);
    assert.strictEqual(bad.ok, true);
    assert.ok(bad.output?.includes('已写入 src.js'), `写入输出缺失: ${bad.output}`);
    assert.ok(bad.output?.includes('[自验证回环]'), `未回灌回环段: ${bad.output}`);
    assert.ok(bad.output?.includes('not ok'), `未回灌失败摘要: ${bad.output}`);

    // ② 修好代码：写回干净源码 → 测试通过 ⇒ 静默（不含回环段）。
    const good = await port.execute(writeCall('c2', 'export const a = 1;\n'), ctx);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(
      good.output?.includes('[自验证回环]'),
      false,
      `测试通过时不应回灌: ${good.output}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P3 装配纪律：策略为 undefined（仓库无测试脚本）时不包装装饰器', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-selfverify-noscript-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    assert.strictEqual(SelfVerifyPolicy.forWorkspace(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
