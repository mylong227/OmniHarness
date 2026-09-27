/**
 * serve 配置**分层加载**回归（2026-09-27 验收实测缺陷）。
 *
 * ## 缺陷形态（真实，非假想）
 *
 * `dsh exec` 走 `execCli.loadDefaults` → `configFile.loadLayered`（用户级 → 项目级 → profile → bundle → env）；
 * 而 `dsh serve`（Web UI）此前走的是 `configFile.find(wsRoot)` + **单文件 `load`** —— 只读**项目级那一份**。
 * 于是用户级 `~/.omniharness/omniharness.json` 里的 `modelAdapter` / `providerKeys` / `model` / `reasoning`
 * 被**静默忽略**：验收实测 `dsh serve` 起来后 `config.get` 报 `modelAdapter: mock`，而用户配置里明明是
 * 真实 provider + 凭据。同一仓库里「一次性运行用真模型、Web UI 用 mock」这种自相矛盾，UI 上完全看不出来。
 *
 * 本测试锁死：**用户级层必须参与合并，且项目级层优先于用户级**（否则又是一个静默失效）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliServerCmds } from '../../src/cli/cliServerCmds.js';
import { ArgParser } from '../../src/cli/argParser.js';

/** 造一个临时家目录，写入用户级 `~/.omniharness/omniharness.json`。 */
function makeHome(cfg: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'omni-home-'));
  mkdirSync(join(home, '.omniharness'), { recursive: true });
  writeFileSync(join(home, '.omniharness', 'omniharness.json'), JSON.stringify(cfg), 'utf8');
  return home;
}

/** 造一个临时工作区，写入项目级 `omniharness.json`。 */
function makeWorkspace(cfg: Record<string, unknown>): string {
  const ws = mkdtempSync(join(tmpdir(), 'omni-ws-'));
  writeFileSync(join(ws, 'omniharness.json'), JSON.stringify(cfg), 'utf8');
  return ws;
}

test('serve：用户级配置必须生效（修复前此处的 modelAdapter/providerKeys 被静默丢弃）', () => {
  const home = makeHome({
    modelAdapter: 'openai',
    model: 'deepseek-v4-flash',
    providerKeys: { deepseek: 'sk-test-not-a-real-key' },
  });
  const ws = makeWorkspace({ approval: 'rules' });
  try {
    const merged = CliServerCmds.loadServeConfig(ws, join(ws, 'omniharness.json'), undefined, home);
    assert.strictEqual(merged.approval, 'rules', '项目级层必须在');
    assert.strictEqual(merged.modelAdapter, 'openai', '用户级层的适配器选择必须生效');
    assert.strictEqual(merged.model, 'deepseek-v4-flash');
    assert.deepStrictEqual(merged.providerKeys, { deepseek: 'sk-test-not-a-real-key' });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('serve：项目级覆盖用户级（分层顺序不得颠倒）', () => {
  const home = makeHome({ modelAdapter: 'openai', model: 'from-user-home' });
  const ws = makeWorkspace({ modelAdapter: 'mock', model: 'from-project' });
  try {
    const merged = CliServerCmds.loadServeConfig(ws, join(ws, 'omniharness.json'), undefined, home);
    assert.strictEqual(merged.modelAdapter, 'mock', '项目级必须压过用户级');
    assert.strictEqual(merged.model, 'from-project');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('serve：环境变量层优先级最高（仍低于 CLI 参数）', () => {
  const home = makeHome({ model: 'from-user-home' });
  const ws = makeWorkspace({ model: 'from-project' });
  const prev = process.env['OMNIHARNESS_MODEL'];
  process.env['OMNIHARNESS_MODEL'] = 'from-env';
  try {
    const merged = CliServerCmds.loadServeConfig(ws, join(ws, 'omniharness.json'), undefined, home);
    assert.strictEqual(merged.model, 'from-env', 'env 层必须压过两层文件');
  } finally {
    if (prev === undefined) delete process.env['OMNIHARNESS_MODEL'];
    else process.env['OMNIHARNESS_MODEL'] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('serve：显示配置必须反映后端实际所用（含 reasoning——曾漏出该项）', () => {
  const home = makeHome({
    modelAdapter: 'openai',
    model: 'deepseek-v4-flash',
    reasoning: 'high',
    approval: 'auto',
  });
  const ws = makeWorkspace({});
  try {
    const merged = CliServerCmds.loadServeConfig(ws, join(ws, 'omniharness.json'), undefined, home);
    // 后端真正用的口径（configDefaults 把它并进 CLI 参数 ⇒ 运行时按 high 跑）。
    assert.strictEqual(ArgParser.configDefaults(merged).reasoning, 'high');
    // UI 展示的口径必须与之一致；2026-09-27 跑真 UI 时这里曾是空白（UI 显示「默认」而后端跑 high）。
    const shown = CliServerCmds.displayConfigOf(merged, ArgParser.parseArgs(['serve'])!, ws);
    assert.strictEqual(shown['reasoning'], 'high', 'UI 展示的 reasoning 不得漏项');
    assert.strictEqual(shown['modelAdapter'], 'openai');
    assert.strictEqual(shown['model'], 'deepseek-v4-flash');
    assert.strictEqual(shown['approval'], 'auto');
    // 未配置时不显示成别的东西（空串 ⇒ UI 走自己的默认展示）。
    assert.strictEqual(shown['workspace'], ws);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('serve：接线守卫——runServe 必须走 loadServeConfig（防退回单文件 load）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', '..', 'src', 'cli', 'cliServerCmds.ts'), 'utf8');
  assert.match(src, /CliServerCmds\.loadServeConfig\(/, 'runServe 必须调用 loadServeConfig');
  assert.ok(
    !/const loadedFile = configFile\.load\(configPath\);/.test(src),
    '不得退回「单文件 load」——那正是用户级配置被静默忽略的根因',
  );
});
