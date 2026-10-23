/**
 * 工作区信任闸判据（2026-10-22）。
 *
 * 覆盖三条不能退化的边界：
 * 1. **restricted**：项目级 `mcpServers` / `approval` / `sandbox` / `baseUrl` 被忽略，
 *    用户级同名键仍然生效（用户自己的选择不能被工作区覆盖掉）；
 * 2. **trusted + TOFU**：显式授权后应用；重启后仍应用；配置内容一变 ⇒ 指纹失效、回到 restricted；
 * 3. **policy floor**：即使已信任，项目级 `approval:auto` / `sandbox:passthrough` 也不生效
 *    （只能由 CLI 显式旗标给出），且 bundle patch 与项目配置走同一条规则。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigFile } from '../../src/config/configFile.ts';
import { ConfigError } from '../../src/config/configError.ts';
import { WorkspaceTrust } from '../../src/config/workspaceTrust.ts';
import { ArgParser } from '../../src/cli/argParser.ts';
import type { WorkspaceTrustDecision } from '../../src/ports/config/workspaceTrust.ts';

/** 临时家目录 + 用户级配置。 */
function makeHome(cfg: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'omni-trust-home-'));
  mkdirSync(join(home, '.omniharness'), { recursive: true });
  writeFileSync(join(home, '.omniharness', 'omniharness.json'), JSON.stringify(cfg), 'utf8');
  return home;
}

/** 临时工作区 + 项目级配置。 */
function makeWorkspace(cfg: Record<string, unknown>): string {
  const ws = mkdtempSync(join(tmpdir(), 'omni-trust-ws-'));
  writeFileSync(join(ws, 'omniharness.json'), JSON.stringify(cfg), 'utf8');
  return ws;
}

/** 清理临时目录。 */
function cleanup(...paths: readonly string[]): void {
  for (const path of paths) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** 读取一次分层配置并捕获信任决策。 */
function loadWithTrust(
  workspace: string,
  home: string,
  grant: boolean,
): { config: ReturnType<ConfigFile['loadLayered']>; decision: WorkspaceTrustDecision } {
  let decision: WorkspaceTrustDecision | undefined;
  const config = new ConfigFile().loadLayered({
    workspace,
    userHomedir: home,
    trust: {
      grant,
      onDecision: (value) => {
        decision = value;
      },
    },
  });
  assert.ok(decision !== undefined, '必须产出信任决策');
  return { config, decision };
}

test('restricted：项目级权威键被忽略，用户级同名键仍生效', () => {
  const home = makeHome({ apiKey: 'user-key', approval: 'rules' });
  const ws = makeWorkspace({
    model: 'project-model',
    approval: 'auto',
    sandbox: 'passthrough',
    baseUrl: 'https://evil.example',
    mcpServers: [{ name: 'x', command: 'node', args: ['-e', 'x'] }],
  });
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(decision.mode, 'restricted');
    assert.strictEqual(decision.granted, false);
    assert.strictEqual(config.model, 'project-model', '只读语义键仍应生效');
    assert.strictEqual(config.apiKey, 'user-key', '用户级凭据不能被工作区配置顶掉');
    assert.strictEqual(config.approval, 'rules', '用户级审批档仍生效');
    assert.strictEqual(config.sandbox, undefined, '项目级 sandbox 必须被忽略');
    assert.strictEqual(config.baseUrl, undefined, '项目级 baseUrl 必须被忽略');
    assert.strictEqual(config.mcpServers, undefined, '项目级 mcpServers 必须被忽略');
    const keys = new Set(decision.ignored.map((entry) => entry.key));
    assert.ok(keys.has('mcpServers'));
    assert.ok(keys.has('approval'));
    assert.ok(keys.has('sandbox'));
    assert.ok(keys.has('baseUrl'));
  } finally {
    cleanup(home, ws);
  }
});

test('trusted + TOFU：显式授权后应用；重启仍应用；配置变化后自动失效', () => {
  const home = makeHome({});
  const ws = makeWorkspace({
    approval: 'deny',
    sandbox: 'policy',
    baseUrl: 'https://ok.example',
    mcpServers: [{ name: 'ok', command: 'node' }],
  });
  try {
    const first = loadWithTrust(ws, home, true);
    assert.strictEqual(first.decision.mode, 'trusted');
    assert.strictEqual(first.decision.granted, true);
    assert.strictEqual(first.config.approval, 'deny');
    assert.strictEqual(first.config.sandbox, 'policy');
    assert.strictEqual(first.config.baseUrl, 'https://ok.example');
    assert.strictEqual(first.config.mcpServers?.length, 1);

    const second = loadWithTrust(ws, home, false);
    assert.strictEqual(second.decision.mode, 'trusted', '同一指纹重启后应仍被信任');
    assert.strictEqual(second.config.mcpServers?.length, 1);

    // 改工作区配置 ⇒ 指纹变化 ⇒ 回到 restricted。
    writeFileSync(
      join(ws, 'omniharness.json'),
      JSON.stringify({
        approval: 'deny',
        sandbox: 'policy',
        baseUrl: 'https://ok.example',
        mcpServers: [{ name: 'ok', command: 'node' }],
        model: 'changed',
      }),
      'utf8',
    );
    const third = loadWithTrust(ws, home, false);
    assert.strictEqual(third.decision.mode, 'restricted', '配置变化后必须重新确认');
    assert.strictEqual(third.config.mcpServers, undefined);
  } finally {
    cleanup(home, ws);
  }
});

test('policy floor：即使已信任，项目级 approval:auto / sandbox:passthrough 也不生效', () => {
  const home = makeHome({ approval: 'rules' });
  const ws = makeWorkspace({ approval: 'auto', sandbox: 'passthrough', model: 'm' });
  try {
    const { config, decision } = loadWithTrust(ws, home, true);
    assert.strictEqual(decision.mode, 'trusted');
    assert.strictEqual(config.approval, 'rules', '用户级 rules 保留');
    assert.strictEqual(config.sandbox, undefined, '项目级 passthrough 被策略地板拒绝');
    const floor = decision.ignored.filter((entry) => entry.reason === 'policy-floor');
    assert.deepStrictEqual(floor.map((entry) => entry.key).sort(), ['approval', 'sandbox']);
  } finally {
    cleanup(home, ws);
  }
});

test('bundle patch 与项目配置同规则：restricted 下权威键被忽略', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ model: 'm' });
  mkdirSync(join(ws, '.omniharness', 'bundle-patches'), { recursive: true });
  writeFileSync(
    join(ws, '.omniharness', 'bundle-patches', 'x.json'),
    JSON.stringify({
      patches: [
        { key: 'approval', value: 'auto' },
        { key: 'mcpServers', value: [{ name: 'b', command: 'node' }] },
      ],
    }),
    'utf8',
  );
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.approval, undefined);
    assert.strictEqual(config.mcpServers, undefined);
    const bundleKeys = decision.ignored
      .filter((entry) => entry.source === 'bundle')
      .map((entry) => entry.key)
      .sort();
    assert.deepStrictEqual(bundleKeys, ['approval', 'mcpServers']);
  } finally {
    cleanup(home, ws);
  }
});

test('没有权威键时不刷屏：只读语义配置照常合并，describe 为空', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ model: 'm', reasoning: 'high' });
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.model, 'm');
    assert.strictEqual(config.reasoning, 'high');
    assert.strictEqual(decision.ignored.length, 0);
    assert.deepStrictEqual(WorkspaceTrust.describe(decision), []);
  } finally {
    cleanup(home, ws);
  }
});

test('trust.json 损坏时 fail-closed 到 restricted，并给出可行动告警', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ approval: 'deny' });
  mkdirSync(join(home, '.omniharness'), { recursive: true });
  writeFileSync(join(home, '.omniharness', 'trust.json'), '{ not-json', 'utf8');
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(decision.mode, 'restricted');
    assert.strictEqual(config.approval, undefined);
    assert.ok(
      decision.warnings.some((warning) => warning.includes('trust.json')),
      '损坏必须出现在告警里，不能静默',
    );
    const lines = WorkspaceTrust.describe(decision);
    assert.ok(lines.some((line) => line.includes('--trust-workspace')));
  } finally {
    cleanup(home, ws);
  }
});

test('项目 profile 的 extends 父链也受信任闸约束（不能从父 profile 绕过）', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ model: 'm' });
  mkdirSync(join(ws, 'profiles'), { recursive: true });
  writeFileSync(
    join(ws, 'profiles', 'base.json'),
    JSON.stringify({ approval: 'auto', sandbox: 'passthrough' }),
    'utf8',
  );
  writeFileSync(
    join(ws, 'profiles', 'child.json'),
    JSON.stringify({ extends: 'base', model: 'child-model' }),
    'utf8',
  );
  try {
    const config = new ConfigFile().loadLayered({
      workspace: ws,
      userHomedir: home,
      profile: 'child',
      trust: { grant: false },
    });
    assert.strictEqual(config.model, 'child-model');
    assert.strictEqual(config.approval, undefined, '父 profile 的 approval 不能被继承绕过');
    assert.strictEqual(config.sandbox, undefined);
  } finally {
    cleanup(home, ws);
  }
});

test('BOM 项目配置不能绕过：决策必须与实际 readStrict 看到同一份内容', () => {
  const home = makeHome({});
  const ws = mkdtempSync(join(tmpdir(), 'omni-trust-bom-'));
  writeFileSync(
    join(ws, 'omniharness.json'),
    '\uFEFF' + JSON.stringify({ approval: 'auto', mcpServers: [{ name: 'b', command: 'node' }] }),
    'utf8',
  );
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.approval, undefined);
    assert.strictEqual(config.mcpServers, undefined);
    assert.ok(decision.ignored.some((entry) => entry.key === 'mcpServers'));
  } finally {
    cleanup(home, ws);
  }
});

test('键别名不能绕过：base_url/api_key/elevated_sandbox 按标准键分类', () => {
  const home = makeHome({});
  const ws = makeWorkspace({
    model: 'm',
    base_url: 'https://evil.example',
    api_key: 'sk-leak',
    elevated_sandbox: 'passthrough',
    approval: 'auto',
  });
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.baseUrl, undefined);
    assert.strictEqual(config.apiKey, undefined);
    assert.strictEqual(config.elevatedSandbox, undefined);
    const keys = new Set(decision.ignored.map((entry) => entry.key));
    assert.ok(keys.has('baseUrl'));
    assert.ok(keys.has('apiKey'));
    // 别名也要走 policy floor：信任后 elevated_sandbox 仍不能把隔离降为 passthrough。
    const trusted = loadWithTrust(ws, home, true);
    assert.strictEqual(trusted.config.elevatedSandbox, undefined);
    assert.ok(
      trusted.decision.ignored.some(
        (entry) => entry.key === 'elevatedSandbox' && entry.reason === 'policy-floor',
      ),
    );
  } finally {
    cleanup(home, ws);
  }
});

test('media / storageDir 不再算安全键：未信任时整体忽略（媒体路径可执行程序）', () => {
  const home = makeHome({});
  const ws = makeWorkspace({
    model: 'm',
    storageDir: 'D:/outside/sessions',
    media: { ffmpegPath: 'D:/evil/ffmpeg.exe' },
  });
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.storageDir, undefined);
    assert.strictEqual(config.media, undefined);
    assert.ok(decision.ignored.some((entry) => entry.key === 'media'));
    assert.ok(decision.ignored.some((entry) => entry.key === 'storageDir'));
  } finally {
    cleanup(home, ws);
  }
});

test('工作区根是权威键：未信任项目不能把运行时根指向别的目录（用户级选择保留）', () => {
  const home = makeHome({ workspace: 'D:/user-root' });
  const ws = makeWorkspace({ model: 'm', workspace: 'D:/victim' });
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.workspace, 'D:/user-root', '用户级工作区选择必须保留');
    assert.ok(decision.ignored.some((entry) => entry.key === 'workspace'));
  } finally {
    cleanup(home, ws);
  }
});

test('只有项目级 workspace 时被忽略，不会进入 configDefaults', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ model: 'm', workspace: 'D:/victim' });
  try {
    const { config } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.workspace, undefined);
    assert.strictEqual(
      ArgParser.configDefaults(config).workspace,
      undefined,
      '未信任项目 workspace 不得进入 configDefaults（否则 goal/workflow/tui 会把沙箱根指向别处）',
    );
  } finally {
    cleanup(home, ws);
  }
});

test('BOM bundle patch 不能绕过：补丁层与项目层同规则', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ model: 'm' });
  mkdirSync(join(ws, '.omniharness', 'bundle-patches'), { recursive: true });
  writeFileSync(
    join(ws, '.omniharness', 'bundle-patches', 'bom.json'),
    '\uFEFF' + JSON.stringify({ patches: [{ key: 'approval', value: 'deny' }] }),
    'utf8',
  );
  try {
    const { config, decision } = loadWithTrust(ws, home, false);
    assert.strictEqual(config.approval, undefined);
    assert.ok(
      decision.ignored.some((entry) => entry.source === 'bundle' && entry.key === 'approval'),
    );
    // 正对照：同一份 BOM 补丁在信任后必须真的生效（证明补丁被解析，而不是被跳过）。
    const trusted = loadWithTrust(ws, home, true);
    assert.strictEqual(trusted.config.approval, 'deny');
  } finally {
    cleanup(home, ws);
  }
});

test('显式 --config 指向工作区外也不能绕过：仍按当前工作区信任模式过滤', () => {
  const home = makeHome({});
  const ws = makeWorkspace({ model: 'm' });
  const outside = mkdtempSync(join(tmpdir(), 'omni-trust-outside-'));
  const configPath = join(outside, 'omniharness.json');
  writeFileSync(configPath, JSON.stringify({ approval: 'auto', mcpServers: [] }), 'utf8');
  try {
    const config = new ConfigFile().loadLayered({
      workspace: ws,
      configPath,
      userHomedir: home,
      trust: { grant: false },
    });
    assert.strictEqual(config.approval, undefined);
    assert.strictEqual(config.mcpServers, undefined);
  } finally {
    cleanup(home, ws, outside);
  }
});

test('DPAPI 同族键一起过滤：明文/密文不能只删一个', () => {
  const decision: WorkspaceTrustDecision = {
    mode: 'restricted',
    workspace: 'D:/ws',
    configHash: 'h',
    requested: [],
    ignored: [{ key: 'apiKey', source: 'project', reason: 'untrusted', summary: '<redacted>' }],
    granted: false,
    warnings: [],
  };
  const filtered = WorkspaceTrust.filter(
    { apiKey: 'plain', apiKeyDpapi: 'cipher', model: 'm' },
    'project',
    decision,
  );
  assert.strictEqual(filtered?.apiKey, undefined);
  assert.strictEqual(filtered?.apiKeyDpapi, undefined);
  assert.strictEqual(filtered?.model, 'm');
});

test('过滤以实际层内容兜底：决策快照漏看（TOCTOU）也不能放行权威键', () => {
  const restricted: WorkspaceTrustDecision = {
    mode: 'restricted',
    workspace: 'D:/ws',
    configHash: 'h',
    requested: [],
    ignored: [],
    granted: false,
    warnings: [],
  };
  const filtered = WorkspaceTrust.filter(
    { approval: 'auto', mcpServers: [], model: 'm' },
    'project',
    restricted,
  );
  assert.strictEqual(filtered?.approval, undefined);
  assert.strictEqual(filtered?.mcpServers, undefined);
  assert.strictEqual(filtered?.model, 'm');

  const trusted: WorkspaceTrustDecision = { ...restricted, mode: 'trusted' };
  const floor = WorkspaceTrust.filter({ sandbox: 'passthrough', model: 'm' }, 'project', trusted);
  assert.strictEqual(floor?.sandbox, undefined);
});

test('分类全覆盖：新增配置键必须显式归入安全或权威，不能静默绕过信任闸', () => {
  const unclassified = ConfigError.knownKeys().filter((key) => !WorkspaceTrust.isClassified(key));
  assert.deepStrictEqual(unclassified, []);
});

test('接线守卫：serve/exec 的 --trust-workspace 必须真的进入 loadLayered', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serve = readFileSync(join(here, '..', '..', 'src', 'cli', 'cliServerCmds.ts'), 'utf8');
  const serveTrust = readFileSync(join(here, '..', '..', 'src', 'cli', 'serveTrust.ts'), 'utf8');
  const agent = readFileSync(join(here, '..', '..', 'src', 'cli', 'cliAgentCmds.ts'), 'utf8');
  assert.match(serveTrust, /serveArgs\.includes\('--trust-workspace'\)/u);
  assert.match(serve, /serveTrust\.options/u);
  assert.match(serve, /args\.allowWorkspaceSkills = serveTrust\.state\.trusted/u);
  assert.match(agent, /argv\.includes\('--trust-workspace'\)/u);
  assert.match(agent, /trust:\s*\{/u);
});
