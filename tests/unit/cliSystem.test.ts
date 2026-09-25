import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ArgParser, CliDefaults } from '../../src/cli/argParser.js';
import { configFile } from '../../src/config/configFile.js';

/** CLI 入口路径。 */
const cliPath = resolve(process.cwd(), 'dist/src/cli/exec.js');

test('parseArgs：配置文件默认值生效且 CLI 参数优先', () => {
  const fromConfig = ArgParser.parseArgs(['--prompt', 'hi'], {
    storageAdapter: 'jsonl',
    sandbox: 'policy',
    maxSteps: 32,
  });
  assert.strictEqual(fromConfig?.storageAdapter, 'jsonl');
  assert.strictEqual(fromConfig?.sandbox, 'policy');
  assert.strictEqual(fromConfig?.maxSteps, 32);

  const overridden = ArgParser.parseArgs(['--prompt', 'hi', '--storage-adapter', 'memory'], {
    storageAdapter: 'jsonl',
  });
  assert.strictEqual(overridden?.storageAdapter, 'memory');
});

test('CliDefaults.sandbox 默认为 policy（开箱默认拦截，P0 行为变更防回归）', () => {
  assert.strictEqual(
    CliDefaults.sandbox,
    'policy',
    '默认 passthrough=开箱零隔离属安全缺口，翻转为 policy 后不得回退',
  );
  assert.strictEqual(
    CliDefaults.elevatedSandbox,
    'policy',
    '提权复核沙箱默认 policy（fail-closed 收紧），杜绝启用 auto/ask 提权即静默全放行',
  );
});

test('ConfigFile：向上逐级查找配置文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omniharness-'));
  await writeFile(
    join(root, 'omniharness.json'),
    JSON.stringify({ storageAdapter: 'jsonl' }),
    'utf8',
  );
  const sub = join(root, 'a', 'b');
  await mkdir(sub, { recursive: true });

  const found = configFile.find(sub);
  assert.strictEqual(found, join(root, 'omniharness.json'));
  const loaded = configFile.load(found ?? '');
  assert.strictEqual(loaded.storageAdapter, 'jsonl');
});

test('ConfigFile：找不到返回 undefined，坏文件返回空配置', () => {
  const root = join(tmpdir(), `omniharness-none-${Date.now()}`);
  assert.strictEqual(configFile.find(root), undefined);
  assert.deepStrictEqual(configFile.load(join(root, 'omniharness.json')), {});
});

test('session list：列出会话文件', () => {
  const dir = join(tmpdir(), `omniharness-sess-${Date.now()}`);
  const file = join(dir, 'sess_test_1.jsonl');
  const line =
    '{"id":"e1","type":"user","sessionId":"sess_test_1","timestamp":"2026-01-01T00:00:00.000Z","payload":{"content":"x"}}\n';
  execFileSync(process.execPath, [
    '-e',
    `require('node:fs').mkdirSync(${JSON.stringify(dir)}, { recursive: true }); require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(line)});`,
  ]);

  const output = execFileSync(
    process.execPath,
    [cliPath, 'session', 'list', '--storage-dir', dir],
    { encoding: 'utf8' },
  );
  assert.match(output, /sess_test_1/);
  assert.match(output, /1 事件/);
});

test('doctor：输出诊断报告结构正确', () => {
  let output = '';
  try {
    output = execFileSync(process.execPath, [cliPath, 'doctor', '--model-adapter', 'mock'], {
      encoding: 'utf8',
    });
  } catch (error) {
    output = (error as { stdout?: Buffer | string })?.stdout?.toString() ?? '';
  }
  assert.match(output, /OmniHarness 诊断报告/);
  assert.match(output, /Node 版本/);
  assert.match(output, /沙箱后端/);
  assert.match(output, /插件目录可读/);
});

test('doctor：openai 缺 key 报问题（**环境隔离**：不继承机器本地配置与 key）', async () => {
  // 为什么必须隔离（2026-09-22 实测）：本用例此前以仓库根为 cwd 直接跑 doctor，而机器本地可能有
  // `omniharness.json`（内含 providerKeys）⇒ doctor 找到 key、退出码 0，断言 `failed === true` 失败。
  // CI 干净检出下侥幸通过 ⇒ 属**非 hermetic 测试**（沙箱禁「带管道子进程」期间它被整文件跳过，
  // 故该缺陷长期不可见；放开沙箱后立刻暴露）。
  const dir = await mkdtemp(join(tmpdir(), 'omni-doctor-nokey-'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['OPENAI_API_KEY'];
  delete env['DEEPSEEK_API_KEY'];
  delete env['OMNIHARNESS_API_KEY'];
  let failed = false;
  try {
    execFileSync(process.execPath, [cliPath, 'doctor', '--model-adapter', 'openai'], {
      encoding: 'utf8',
      cwd: dir,
      env,
    });
  } catch {
    failed = true;
  }
  assert.strictEqual(failed, true, '无 key 时 doctor 必须报问题并以非零退出');
});

test('compare：两个模型 A/B 对比输出', () => {
  const output = execFileSync(
    process.execPath,
    [cliPath, 'compare', '--prompt', '对比测试', '--adapter-a', 'mock', '--adapter-b', 'mock'],
    { encoding: 'utf8' },
  );
  assert.match(output, /=== A\/B 对比 ===/);
  assert.match(output, /模型 A:/);
  assert.match(output, /模型 B:/);
});
